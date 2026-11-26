import "./load-env.js";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AppDatabase } from "./db.js";
import { ContextManager } from "./context.js";
import { EventHub } from "./events.js";
import { cors } from "./network.js";
import { ProviderClient } from "./providers.js";
import { QueueManager } from "./queue.js";
import { formatSummaryMarkdown, summaryFileName } from "./summary.js";
import type { Provider } from "./types.js";

const port = Number(process.env.PORT ?? 8787);
const maxContextChars = Number(process.env.MAX_CONTEXT_CHARS ?? 48_000);
const db = new AppDatabase(process.env.DATABASE_PATH ?? "data/samisip.sqlite");
const events = new EventHub();
const providers = new ProviderClient();
const context = new ContextManager(db);
const queue = new QueueManager(
  db,
  events,
  providers,
  Number(process.env.MAX_AI_CHAIN_DEPTH ?? 3),
  maxContextChars,
  context
);
const app = express();

app.use(cors());
app.use(express.json({ limit: "128kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/session", (request, response, next) => {
  try {
    const username = String(request.body.username ?? "");
    const displayName = String(request.body.displayName ?? username);
    const user = db.upsertUser(username, displayName);
    response.json({ user, rooms: db.listRooms() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/rooms", (_request, response) => {
  response.json(db.listRooms());
});

app.post("/api/rooms", (request, response, next) => {
  try {
    const room = db.createRoom(String(request.body.name ?? ""), String(request.body.projectBrief ?? ""), String(request.body.userId ?? ""));
    response.status(201).json(room);
  } catch (error) {
    next(error);
  }
});

app.get("/api/rooms/:roomId", (request, response, next) => {
  try {
    response.json(db.getSnapshot(request.params.roomId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/rooms/:roomId/join", (request, response, next) => {
  try {
    db.joinRoom(request.params.roomId, String(request.body.userId ?? ""));
    events.publish({ type: "presence.updated", roomId: request.params.roomId });
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.patch("/api/rooms/:roomId", (request, response, next) => {
  try {
    const room = db.updateRoomBrief(request.params.roomId, String(request.body.projectBrief ?? ""));
    events.publish({ type: "room.updated", roomId: room.id, data: room });
    response.json(room);
  } catch (error) {
    next(error);
  }
});

app.post("/api/rooms/:roomId/messages", (request, response, next) => {
  try {
    const content = String(request.body.content ?? "").trim();
    if (!content || content.length > 12_000) throw new Error("Message must be 1 to 12,000 characters.");
    const userId = String(request.body.userId ?? "");
    db.joinRoom(request.params.roomId, userId);
    const userRow = db.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, unknown> | undefined;
    if (!userRow) throw new Error("User not found.");
    const message = db.insertMessage({
      roomId: request.params.roomId,
      authorType: "human",
      authorId: userId,
      authorUsername: String(userRow.username),
      content,
      parentMessageId: null,
      aiDepth: 0
    });
    events.publish({ type: "message.created", roomId: request.params.roomId, data: message });
    const queued = queue.dispatch(message);
    response.status(201).json({ message, queued });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rooms/:roomId/agents", (request, response, next) => {
  try {
    const provider = String(request.body.provider ?? "") as Provider;
    if (!(["openai", "anthropic"] as Provider[]).includes(provider)) throw new Error("Provider must be openai or anthropic.");
    const agent = db.addAgent({
      roomId: request.params.roomId,
      username: String(request.body.username ?? ""),
      displayName: String(request.body.displayName ?? ""),
      provider,
      baseUrl: String(request.body.baseUrl ?? ""),
      model: String(request.body.model ?? ""),
      apiKeyEnv: String(request.body.apiKeyEnv ?? ""),
      systemPrompt: String(request.body.systemPrompt ?? ""),
      createdBy: String(request.body.userId ?? "")
    });
    events.publish({ type: "room.updated", roomId: request.params.roomId, data: agent });
    response.status(201).json(agent);
  } catch (error) {
    next(error);
  }
});

app.post("/api/rooms/:roomId/summary", async (request, response, next) => {
  try {
    const room = db.getRoom(request.params.roomId);
    const agentId = String(request.body.agentId ?? "");
    const agents = db.listRoomAgents(room.id);
    const agent = agents.find((item) => item.id === agentId);
    if (!agent?.enabled) throw new Error("Choose an enabled AI participant from this room.");
    const plan = context.buildForSummary(room, maxContextChars);
    const generatedAt = new Date().toISOString();
    const body = await providers.generateSummary(agent, room, plan, agents);
    const markdown = formatSummaryMarkdown(room, agent, body, generatedAt, plan.totalMessages);
    response.setHeader("content-type", "text/markdown; charset=utf-8");
    response.setHeader("content-disposition", `attachment; filename="${summaryFileName(room, generatedAt)}"`);
    response.send(markdown);
  } catch (error) {
    next(error);
  }
});

app.get("/api/rooms/:roomId/events", (request, response) => {
  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders();
  response.write(`event: connected\ndata: {"roomId":"${request.params.roomId}"}\n\n`);
  const unsubscribe = events.subscribe(request.params.roomId, response);
  const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

const clientPath = resolve("dist");
if (existsSync(clientPath)) {
  app.use(express.static(clientPath));
  app.get("*splat", (_request, response) => response.sendFile(resolve(clientPath, "index.html")));
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  const status = /not found/i.test(message) ? 404 : 400;
  response.status(status).json({ error: message });
});

const server = app.listen(port, () => {
  console.log(`SamIsip API listening on http://localhost:${port}`);
  queue.resume();
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
