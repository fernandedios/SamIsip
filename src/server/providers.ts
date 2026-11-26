import type { Agent, Message, Room } from "./types.js";

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
}

interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export class ProviderClient {
  async generate(agent: Agent, room: Room, messages: Message[], collaborators: Agent[]): Promise<string> {
    const key = process.env[agent.apiKeyEnv];
    if (!key) throw new Error(`Missing API key in ${agent.apiKeyEnv}.`);
    const system = this.systemPrompt(agent, room, collaborators);
    const history = this.providerMessages(agent, messages);
    return agent.provider === "anthropic"
      ? this.callAnthropic(agent, key, system, history)
      : this.callOpenAI(agent, key, system, history);
  }

  private systemPrompt(agent: Agent, room: Room, collaborators: Agent[]): string {
    const roster = collaborators.map((item) => `@${item.username} (${item.displayName})`).join(", ");
    return [
      `You are @${agent.username}, an AI collaborator in the SamIsip room “${room.name}”.`,
      agent.systemPrompt,
      `Project brief: ${room.projectBrief || "No project brief has been written yet."}`,
      `AI collaborators in this room: ${roster}.`,
      "Reply to the room discussion directly. Do not prefix your answer with your name.",
      "You may deliberately mention another AI username when that collaborator should respond next. Use @all-ai only when every model truly needs a turn.",
      "Do not mention yourself. Avoid ceremonial handoffs and keep the work moving."
    ].filter(Boolean).join("\n\n");
  }

  private providerMessages(agent: Agent, messages: Message[]): ProviderMessage[] {
    const mapped = messages.map<ProviderMessage>((message) => ({
      role: message.authorType === "agent" && message.authorId === agent.id ? "assistant" : "user",
      content: message.authorType === "agent" && message.authorId === agent.id
        ? message.content
        : `${message.authorUsername}: ${message.content}`
    }));
    return mapped.reduce<ProviderMessage[]>((result, item) => {
      const previous = result.at(-1);
      if (previous?.role === item.role) previous.content += `\n\n${item.content}`;
      else result.push({ ...item });
      return result;
    }, []);
  }

  private async callOpenAI(agent: Agent, key: string, system: string, messages: ProviderMessage[]): Promise<string> {
    const response = await fetch(this.endpoint(agent.baseUrl, "chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: agent.model,
        messages: [{ role: "system", content: system }, ...messages],
        temperature: 0.4,
        max_tokens: 1600
      }),
      signal: AbortSignal.timeout(120_000)
    });
    const data = await this.readJson<OpenAIResponse>(response);
    const content = data.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((item) => item.text ?? "").join("") : content;
    if (!text?.trim()) throw new Error("OpenAI-compatible provider returned no text.");
    return text.trim();
  }

  private async callAnthropic(agent: Agent, key: string, system: string, messages: ProviderMessage[]): Promise<string> {
    const response = await fetch(this.endpoint(agent.baseUrl, "messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: agent.model, system, messages, max_tokens: 1600, temperature: 0.4 }),
      signal: AbortSignal.timeout(120_000)
    });
    const data = await this.readJson<AnthropicResponse>(response);
    const text = data.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
    if (!text?.trim()) throw new Error("Anthropic-compatible provider returned no text.");
    return text.trim();
  }

  private endpoint(baseUrl: string, resource: string): string {
    const clean = baseUrl.replace(/\/$/, "");
    if (clean.endsWith(`/${resource}`)) return clean;
    return `${clean}/${resource}`;
  }

  private async readJson<T>(response: Response): Promise<T> {
    const raw = await response.text();
    if (!response.ok) throw new Error(`Provider request failed (${response.status}): ${raw.slice(0, 280)}`);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error("Provider returned invalid JSON.");
    }
  }
}
