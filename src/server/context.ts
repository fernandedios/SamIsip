import type { AppDatabase } from "./db.js";
import type { ContextPlan, ContextSummary, Message, Room } from "./types.js";

const stopWords = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been", "before", "being", "but", "can", "could",
  "does", "for", "from", "have", "into", "its", "just", "more", "not", "our", "should", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "through", "very", "want", "was", "were",
  "what", "when", "where", "which", "while", "will", "with", "would", "you", "your"
]);

export const contextKeywords = (value: string, limit = 12): string[] => {
  const counts = new Map<string, number>();
  for (const word of value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []) {
    if (stopWords.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, limit).map(([word]) => word);
};

export const parseHistorySearch = (value: string): string | null => {
  const match = value.match(/^\s*\[\[search-history:\s*([^\]\n]+)\s*\]\]\s*$/i);
  const query = match?.[1]?.trim();
  return query && query.length >= 3 && query.length <= 200 ? query : null;
};

interface ContextManagerOptions {
  recentMessageLimit?: number;
  summaryChunkSize?: number;
  summaryMinMessages?: number;
  historySearchResults?: number;
}

export class ContextManager {
  private readonly recentMessageLimit: number;
  private readonly summaryChunkSize: number;
  private readonly summaryMinMessages: number;
  private readonly historySearchResults: number;

  constructor(private readonly db: AppDatabase, options: ContextManagerOptions = {}) {
    this.recentMessageLimit = options.recentMessageLimit ?? Number(process.env.CONTEXT_RECENT_MESSAGES ?? 24);
    this.summaryChunkSize = options.summaryChunkSize ?? Number(process.env.CONTEXT_SUMMARY_CHUNK ?? 40);
    this.summaryMinMessages = options.summaryMinMessages ?? Number(process.env.CONTEXT_SUMMARY_MIN_MESSAGES ?? 12);
    this.historySearchResults = options.historySearchResults ?? Number(process.env.MAX_HISTORY_SEARCH_RESULTS ?? 12);
  }

  build(room: Room, sourceMessageId: number, maxChars: number): ContextPlan {
    const source = this.db.getMessage(sourceMessageId);
    return this.buildPlan(room, `${source.content}\n${room.projectBrief}`, maxChars);
  }

  buildForSummary(room: Room, maxChars: number): ContextPlan {
    const query = `${room.projectBrief}\ndecisions requirements constraints risks unresolved questions action items owners next steps`;
    return this.buildPlan(room, query, maxChars);
  }

  private buildPlan(room: Room, query: string, maxChars: number): ContextPlan {
    const recentBudget = Math.max(2_000, Math.floor(maxChars * 0.55));
    const summaryBudget = Math.max(800, Math.floor(maxChars * 0.17));
    const retrievalBudget = Math.max(1_000, Math.floor(maxChars * 0.23));
    const candidates = this.db.listRecentMessages(room.id, Math.max(this.recentMessageLimit * 3, 80));
    const recentMessages = this.takeNewestWithinBudget(candidates, recentBudget, this.recentMessageLimit);
    const oldestRecentMessageId = recentMessages[0]?.id ?? null;
    if (oldestRecentMessageId !== null) this.ensureSummaries(room, oldestRecentMessageId);

    const retrievedMessages = oldestRecentMessageId === null
      ? []
      : this.takeMessagesWithinBudget(this.db.searchMessages(room.id, query, this.historySearchResults, oldestRecentMessageId), retrievalBudget);
    const summaries = this.selectSummaries(this.db.listContextSummaries(room.id), query, summaryBudget);
    const includedChars = [...recentMessages, ...retrievedMessages].reduce((total, message) => total + this.messageCost(message), 0)
      + summaries.reduce((total, summary) => total + summary.summary.length, 0);

    return {
      totalMessages: this.db.countMessages(room.id),
      recentMessages,
      retrievedMessages,
      summaries,
      includedChars,
      oldestRecentMessageId
    };
  }

  searchFullHistory(roomId: string, query: string, excludeIds: Set<number>): Message[] {
    const candidateLimit = Math.min(100, this.historySearchResults + excludeIds.size);
    return this.db.searchMessages(roomId, query, candidateLimit, Number.MAX_SAFE_INTEGER)
      .filter((message) => !excludeIds.has(message.id))
      .slice(0, this.historySearchResults);
  }

  private ensureSummaries(room: Room, oldestRecentMessageId: number): void {
    let afterId = this.db.getLatestSummaryEndMessageId(room.id);
    for (let pass = 0; pass < 6; pass += 1) {
      const messages = this.db.listMessagesForSummary(room.id, afterId, oldestRecentMessageId, this.summaryChunkSize);
      if (messages.length < this.summaryMinMessages) return;
      const summary = this.summarizeChunk(messages, room.projectBrief);
      this.db.insertContextSummary(room.id, messages[0]!.id, messages.at(-1)!.id, messages.length, summary);
      afterId = messages.at(-1)!.id;
      if (messages.length < this.summaryChunkSize) return;
    }
  }

  private summarizeChunk(messages: Message[], projectBrief: string): string {
    const projectTerms = new Set(contextKeywords(projectBrief, 16));
    const candidates: Array<{ message: Message; text: string; order: number; score: number }> = [];
    let order = 0;
    for (const [messageIndex, message] of messages.entries()) {
      const sentences = message.content.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
      for (const raw of sentences) {
        const text = raw.length > 360 ? `${raw.slice(0, 357)}…` : raw;
        const lower = text.toLowerCase();
        const terms = contextKeywords(text, 20);
        let score = Math.min(text.length / 120, 2);
        if (/\b(decision|decided|agreed|choose|chosen)\b/i.test(text)) score += 6;
        if (/\b(must|require|constraint|blocked|risk|deadline|owner|next|todo|action)\b/i.test(text)) score += 4;
        if (/\b(because|therefore|result|means|tradeoff)\b/i.test(text)) score += 2;
        if (text.includes("?")) score += 1.5;
        if (text.includes("@")) score += 1;
        score += terms.filter((term) => projectTerms.has(term)).length * 1.5;
        score += messageIndex / Math.max(1, messages.length - 1);
        candidates.push({ message, text, order: order++, score });
      }
    }
    const selected = candidates.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 8).sort((a, b) => a.order - b.order);
    const range = `Messages #${messages[0]!.id}–#${messages.at(-1)!.id}`;
    return [range, ...selected.map((item) => `- [#${item.message.id} @${item.message.authorUsername}] ${item.text}`)].join("\n");
  }

  private takeNewestWithinBudget(messages: Message[], budget: number, limit: number): Message[] {
    const selected: Message[] = [];
    let used = 0;
    for (const message of [...messages].reverse()) {
      const cost = this.messageCost(message);
      if (selected.length > 0 && (selected.length >= limit || used + cost > budget)) break;
      selected.push(message);
      used += cost;
    }
    return selected.reverse();
  }

  private takeMessagesWithinBudget(messages: Message[], budget: number): Message[] {
    const selected: Message[] = [];
    let used = 0;
    for (const message of messages) {
      const cost = this.messageCost(message);
      if (selected.length > 0 && used + cost > budget) break;
      selected.push(message);
      used += cost;
    }
    return selected.sort((a, b) => a.id - b.id);
  }

  private selectSummaries(summaries: ContextSummary[], query: string, budget: number): ContextSummary[] {
    const terms = new Set(contextKeywords(query, 16));
    const ranked = summaries.map((summary, index) => {
      const text = summary.summary.toLowerCase();
      const overlap = [...terms].filter((term) => text.includes(term)).length;
      return { summary, score: overlap * 5 + index / Math.max(1, summaries.length) };
    }).sort((a, b) => b.score - a.score || b.summary.endMessageId - a.summary.endMessageId);
    const selected: ContextSummary[] = [];
    let used = 0;
    for (const { summary } of ranked) {
      if (selected.length > 0 && used + summary.summary.length > budget) continue;
      selected.push(summary);
      used += summary.summary.length;
    }
    return selected.sort((a, b) => a.startMessageId - b.startMessageId);
  }

  private messageCost(message: Message): number {
    return message.content.length + message.authorUsername.length + 20;
  }
}
