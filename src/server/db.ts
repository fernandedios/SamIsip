import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Agent, ContextRun, ContextStatus, ContextSummary, Job, Message, Provider, Room, RoomSnapshot, RoomSummary, User } from "./types.js";
import { isKeylessModelUrlAllowed } from "./network.js";

const now = () => new Date().toISOString();
const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48);
const searchTerms = (value: string) => [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])].slice(0, 16);
const agentConfigured = (agent: Agent) => agent.apiKeyEnv ? Boolean(process.env[agent.apiKeyEnv]) : isKeylessModelUrlAllowed(agent.baseUrl);

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.initializeSearchIndex();
    this.seed();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        project_brief TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at TEXT NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('openai', 'anthropic')),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key_env TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_agents (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author_type TEXT NOT NULL CHECK(author_type IN ('human', 'agent', 'system')),
        author_id TEXT,
        author_username TEXT NOT NULL,
        content TEXT NOT NULL,
        parent_message_id INTEGER REFERENCES messages(id),
        ai_depth INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_room_id_id ON messages(room_id, id);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        depth INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(source_message_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_room_status_id ON jobs(room_id, status, id);
      CREATE TABLE IF NOT EXISTS context_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        start_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        end_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        message_count INTEGER NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(room_id, start_message_id, end_message_id)
      );
      CREATE INDEX IF NOT EXISTS context_summaries_room_end ON context_summaries(room_id, end_message_id);
      CREATE TABLE IF NOT EXISTS context_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        total_messages INTEGER NOT NULL,
        recent_messages INTEGER NOT NULL,
        retrieved_messages INTEGER NOT NULL,
        summary_chunks INTEGER NOT NULL,
        included_chars INTEGER NOT NULL,
        archive_searches INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS context_runs_room_id ON context_runs(room_id, id DESC);
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        author_username,
        room_id UNINDEXED,
        content = 'messages',
        content_rowid = 'id'
      );
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, author_username, room_id)
        VALUES (new.id, new.content, new.author_username, new.room_id);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, author_username, room_id)
        VALUES ('delete', old.id, old.content, old.author_username, old.room_id);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, author_username, room_id)
        VALUES ('delete', old.id, old.content, old.author_username, old.room_id);
        INSERT INTO messages_fts(rowid, content, author_username, room_id)
        VALUES (new.id, new.content, new.author_username, new.room_id);
      END;
    `);
  }

  private initializeSearchIndex(): void {
    const initialized = this.sqlite.prepare("SELECT value FROM app_meta WHERE key = 'messages_fts_initialized'").get();
    if (initialized) return;
    this.sqlite.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')").run();
    this.sqlite.prepare("INSERT INTO app_meta(key, value) VALUES ('messages_fts_initialized', ?)").run(now());
  }

  private seed(): void {
    const createdAt = now();
    this.sqlite.prepare("INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?)").run("user-sam", "sam", "Sam", createdAt);
    this.sqlite.prepare("INSERT OR IGNORE INTO rooms VALUES (?, ?, ?, ?, ?, ?)").run(
      "room-studio",
      "product-studio",
      "Product studio",
      "Design and ship SamIsip: a focused room where people and AI collaborators can reason together without losing project context.",
      "user-sam",
      createdAt
    );
    this.sqlite.prepare("INSERT OR IGNORE INTO room_members VALUES (?, ?, ?, ?)").run("room-studio", "user-sam", "owner", createdAt);
    this.sqlite.prepare("INSERT OR IGNORE INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "agent-sol", "ai-sol", "Sol", "openai", "https://api.openai.com/v1", "gpt-4.1-mini", "OPENAI_API_KEY",
      "Be the implementation-focused collaborator. Make concrete proposals, surface tradeoffs, and keep responses compact.", 1, "user-sam", createdAt
    );
    this.sqlite.prepare("INSERT OR IGNORE INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "agent-claude", "ai-claude", "Claude", "anthropic", "https://api.anthropic.com/v1", "claude-sonnet-4-5", "ANTHROPIC_API_KEY",
      "Be the critical product collaborator. Test assumptions, synthesize the discussion, and suggest the next decision.", 1, "user-sam", createdAt
    );
    this.sqlite.prepare("INSERT OR IGNORE INTO room_agents VALUES (?, ?, ?, ?)").run("room-studio", "agent-sol", 0, createdAt);
    this.sqlite.prepare("INSERT OR IGNORE INTO room_agents VALUES (?, ?, ?, ?)").run("room-studio", "agent-claude", 1, createdAt);
    const count = this.sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE room_id = ?").get("room-studio") as { count: number };
    if (count.count === 0) {
      this.insertMessage({
        roomId: "room-studio",
        authorType: "system",
        authorId: null,
        authorUsername: "SamIsip",
        content: "This room keeps the project brief and full discussion history. Mention @ai-sol, @ai-claude, or @all-ai when you want a model turn.",
        parentMessageId: null,
        aiDepth: 0
      });
    }
    const sample = this.sqlite.prepare("SELECT 1 FROM messages WHERE room_id = ? AND content LIKE 'The smallest useful loop%' LIMIT 1").get("room-studio");
    if (!sample) {
      const examples: Array<Omit<Message, "id" | "createdAt" | "roomId">> = [
        {
          authorType: "human", authorId: "user-sam", authorUsername: "sam",
          content: "We need the first version to feel like a real project room, not a model switcher. What is the smallest useful collaboration loop?",
          parentMessageId: null, aiDepth: 0
        },
        {
          authorType: "agent", authorId: "agent-sol", authorUsername: "ai-sol",
          content: "The smallest useful loop is: write the brief once, discuss normally, mention a model only when it has a job, and keep its reply in the same durable transcript. Queue state should be visible beside the discussion.",
          parentMessageId: null, aiDepth: 1
        },
        {
          authorType: "agent", authorId: "agent-claude", authorUsername: "ai-claude",
          content: "The product risk is uncontrolled participation. Explicit mentions and a depth-limited handoff make the room understandable: people can see who was asked, in what order, and why another model joined.",
          parentMessageId: null, aiDepth: 1
        },
        {
          authorType: "human", authorId: "user-sam", authorUsername: "sam",
          content: "Decision: keep human conversation quiet by default. @all-ai is deliberate fan-out, and named mentions are the normal way to request a model turn.",
          parentMessageId: null, aiDepth: 0
        },
        {
          authorType: "agent", authorId: "agent-sol", authorUsername: "ai-sol",
          content: "That gives us a clean MVP boundary. Persist rooms, messages, model definitions, and jobs; execute one model at a time per room so later collaborators can build on earlier replies.",
          parentMessageId: null, aiDepth: 1
        }
      ];
      for (const example of examples) this.insertMessage({ roomId: "room-studio", ...example });
    }
    this.sqlite.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run();
  }

  upsertUser(username: string, displayName: string): User {
    const cleanUsername = this.cleanUsername(username);
    const existing = this.sqlite.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(cleanUsername) as Record<string, unknown> | undefined;
    if (existing) {
      this.sqlite.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName.trim(), existing.id as string);
      return this.mapUser({ ...existing, display_name: displayName.trim() });
    }
    const user: User = { id: randomUUID(), username: cleanUsername, displayName: displayName.trim(), createdAt: now() };
    this.sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, ?)").run(user.id, user.username, user.displayName, user.createdAt);
    return user;
  }

  listRooms(): RoomSummary[] {
    const rows = this.sqlite.prepare(`
      SELECT r.*,
        (SELECT content FROM messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS member_count,
        (SELECT COUNT(*) FROM room_agents ra WHERE ra.room_id = r.id) AS agent_count
      FROM rooms r ORDER BY COALESCE(last_message_at, r.created_at) DESC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      room: this.mapRoom(row),
      lastMessage: row.last_message as string | null,
      lastMessageAt: row.last_message_at as string | null,
      memberCount: Number(row.member_count),
      agentCount: Number(row.agent_count)
    }));
  }

  createRoom(name: string, projectBrief: string, userId: string): Room {
    const cleanName = name.trim();
    if (cleanName.length < 2 || cleanName.length > 80) throw new Error("Room name must be 2 to 80 characters.");
    const baseSlug = slugify(cleanName) || "room";
    let slug = baseSlug;
    let suffix = 2;
    while (this.sqlite.prepare("SELECT 1 FROM rooms WHERE slug = ?").get(slug)) slug = `${baseSlug}-${suffix++}`;
    const room: Room = { id: randomUUID(), slug, name: cleanName, projectBrief: projectBrief.trim(), createdBy: userId, createdAt: now() };
    this.sqlite.prepare("INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?)").run(room.id, room.slug, room.name, room.projectBrief, room.createdBy, room.createdAt);
    this.joinRoom(room.id, userId, "owner");
    return room;
  }

  joinRoom(roomId: string, userId: string, role = "member"): void {
    this.sqlite.prepare("INSERT OR IGNORE INTO room_members VALUES (?, ?, ?, ?)").run(roomId, userId, role, now());
  }

  updateRoomBrief(roomId: string, projectBrief: string): Room {
    this.sqlite.prepare("UPDATE rooms SET project_brief = ? WHERE id = ?").run(projectBrief.trim(), roomId);
    return this.getRoom(roomId);
  }

  getRoom(roomId: string): Room {
    const row = this.sqlite.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Room not found.");
    return this.mapRoom(row);
  }

  getSnapshot(roomId: string): RoomSnapshot {
    const messages = (this.sqlite.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 200").all(roomId) as Record<string, unknown>[])
      .reverse().map((row) => this.mapMessage(row));
    const members = (this.sqlite.prepare(`
      SELECT u.* FROM users u JOIN room_members rm ON rm.user_id = u.id
      WHERE rm.room_id = ? ORDER BY rm.joined_at
    `).all(roomId) as Record<string, unknown>[]).map((row) => this.mapUser(row));
    const agents = this.listRoomAgents(roomId).map((agent) => ({ ...agent, configured: agentConfigured(agent) }));
    const jobs = (this.sqlite.prepare(`
      SELECT j.*, a.username AS agent_username FROM jobs j JOIN agents a ON a.id = j.agent_id
      WHERE j.room_id = ? ORDER BY j.id DESC LIMIT 20
    `).all(roomId) as Record<string, unknown>[]).map((row) => this.mapJob(row));
    return { room: this.getRoom(roomId), messages, members, agents, jobs, contextStatus: this.getContextStatus(roomId) };
  }

  addAgent(input: {
    roomId: string;
    username: string;
    displayName: string;
    provider: Provider;
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    systemPrompt: string;
    createdBy: string;
  }): Agent {
    const username = this.cleanUsername(input.username);
    if (!username.startsWith("ai-")) throw new Error("AI usernames must start with ai-.");
    const url = new URL(input.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Model URL must use HTTP or HTTPS.");
    const apiKeyEnv = input.apiKeyEnv.trim();
    if (apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error("API key environment variable is invalid.");
    if (!apiKeyEnv && !isKeylessModelUrlAllowed(url.toString())) {
      throw new Error("A key environment variable is required unless the model URL uses loopback, a private LAN address, or an origin listed in KEYLESS_MODEL_ORIGINS.");
    }
    const agent: Agent = {
      id: randomUUID(),
      username,
      displayName: input.displayName.trim(),
      provider: input.provider,
      baseUrl: url.toString().replace(/\/$/, ""),
      model: input.model.trim(),
      apiKeyEnv,
      systemPrompt: input.systemPrompt.trim(),
      enabled: true,
      createdBy: input.createdBy,
      createdAt: now()
    };
    this.sqlite.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      agent.id, agent.username, agent.displayName, agent.provider, agent.baseUrl, agent.model,
      agent.apiKeyEnv, agent.systemPrompt, 1, agent.createdBy, agent.createdAt
    );
    const positionRow = this.sqlite.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_agents WHERE room_id = ?").get(input.roomId) as { position: number };
    this.sqlite.prepare("INSERT INTO room_agents VALUES (?, ?, ?, ?)").run(input.roomId, agent.id, positionRow.position, now());
    return { ...agent, position: positionRow.position, configured: agentConfigured(agent) };
  }

  listRoomAgents(roomId: string): Agent[] {
    const rows = this.sqlite.prepare(`
      SELECT a.*, ra.position FROM agents a JOIN room_agents ra ON ra.agent_id = a.id
      WHERE ra.room_id = ? ORDER BY ra.position, a.created_at
    `).all(roomId) as Record<string, unknown>[];
    return rows.map((row) => this.mapAgent(row));
  }

  getAgent(agentId: string): Agent {
    const row = this.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Agent not found.");
    return this.mapAgent(row);
  }

  insertMessage(input: Omit<Message, "id" | "createdAt">): Message {
    const createdAt = now();
    const result = this.sqlite.prepare(`
      INSERT INTO messages (room_id, author_type, author_id, author_username, content, parent_message_id, ai_depth, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.roomId, input.authorType, input.authorId, input.authorUsername, input.content.trim(), input.parentMessageId, input.aiDepth, createdAt);
    return { ...input, id: Number(result.lastInsertRowid), createdAt };
  }

  getMessage(messageId: number): Message {
    const row = this.sqlite.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Message not found.");
    return this.mapMessage(row);
  }

  countMessages(roomId: string): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE room_id = ?").get(roomId) as { count: number };
    return Number(row.count);
  }

  listRecentMessages(roomId: string, limit: number): Message[] {
    return (this.sqlite.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?").all(roomId, limit) as Record<string, unknown>[])
      .reverse().map((row) => this.mapMessage(row));
  }

  listMessagesForSummary(roomId: string, afterId: number, beforeId: number, limit: number): Message[] {
    return (this.sqlite.prepare(`
      SELECT * FROM messages WHERE room_id = ? AND id > ? AND id < ? ORDER BY id LIMIT ?
    `).all(roomId, afterId, beforeId, limit) as Record<string, unknown>[]).map((row) => this.mapMessage(row));
  }

  getLatestSummaryEndMessageId(roomId: string): number {
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(end_message_id), 0) AS id FROM context_summaries WHERE room_id = ?").get(roomId) as { id: number };
    return Number(row.id);
  }

  insertContextSummary(roomId: string, startMessageId: number, endMessageId: number, messageCount: number, summary: string): ContextSummary {
    const createdAt = now();
    const result = this.sqlite.prepare(`
      INSERT OR IGNORE INTO context_summaries (room_id, start_message_id, end_message_id, message_count, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, startMessageId, endMessageId, messageCount, summary, createdAt);
    const id = result.changes === 0
      ? (this.sqlite.prepare("SELECT id FROM context_summaries WHERE room_id = ? AND start_message_id = ? AND end_message_id = ?").get(roomId, startMessageId, endMessageId) as { id: number }).id
      : Number(result.lastInsertRowid);
    const row = this.sqlite.prepare("SELECT * FROM context_summaries WHERE id = ?").get(id) as Record<string, unknown>;
    return this.mapContextSummary(row);
  }

  listContextSummaries(roomId: string): ContextSummary[] {
    return (this.sqlite.prepare("SELECT * FROM context_summaries WHERE room_id = ? ORDER BY start_message_id").all(roomId) as Record<string, unknown>[])
      .map((row) => this.mapContextSummary(row));
  }

  searchMessages(roomId: string, query: string, limit: number, beforeMessageId: number): Message[] {
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    try {
      const rows = this.sqlite.prepare(`
        SELECT m.* FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ? AND m.room_id = ? AND m.id < ?
        ORDER BY bm25(messages_fts), m.id DESC LIMIT ?
      `).all(ftsQuery, roomId, beforeMessageId, limit) as Record<string, unknown>[];
      return rows.map((row) => this.mapMessage(row));
    } catch {
      const rows = this.sqlite.prepare("SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC").all(roomId, beforeMessageId) as Record<string, unknown>[];
      return rows.map((row) => this.mapMessage(row)).map((message) => ({
        message,
        score: terms.reduce((score, term) => score + (message.content.toLowerCase().includes(term) ? 1 : 0), 0)
      })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.message.id - a.message.id).slice(0, limit).map((item) => item.message);
    }
  }

  recordContextRun(jobId: number, roomId: string, input: {
    totalMessages: number;
    recentMessages: number;
    retrievedMessages: number;
    summaryChunks: number;
    includedChars: number;
    archiveSearches: number;
  }): ContextRun {
    const createdAt = now();
    this.sqlite.prepare(`
      INSERT INTO context_runs (
        job_id, room_id, total_messages, recent_messages, retrieved_messages, summary_chunks,
        included_chars, archive_searches, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        total_messages = excluded.total_messages,
        recent_messages = excluded.recent_messages,
        retrieved_messages = excluded.retrieved_messages,
        summary_chunks = excluded.summary_chunks,
        included_chars = excluded.included_chars,
        archive_searches = excluded.archive_searches,
        created_at = excluded.created_at
    `).run(
      jobId, roomId, input.totalMessages, input.recentMessages, input.retrievedMessages,
      input.summaryChunks, input.includedChars, input.archiveSearches, createdAt
    );
    const row = this.sqlite.prepare("SELECT * FROM context_runs WHERE job_id = ?").get(jobId) as Record<string, unknown>;
    return this.mapContextRun(row);
  }

  getContextStatus(roomId: string): ContextStatus {
    const messages = this.sqlite.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM messages WHERE room_id = ?
    `).get(roomId) as { count: number; chars: number };
    const summaries = this.sqlite.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(message_count), 0) AS messages FROM context_summaries WHERE room_id = ?
    `).get(roomId) as { count: number; messages: number };
    const lastRunRow = this.sqlite.prepare("SELECT * FROM context_runs WHERE room_id = ? ORDER BY id DESC LIMIT 1").get(roomId) as Record<string, unknown> | undefined;
    return {
      fullMessageCount: Number(messages.count),
      fullMessageChars: Number(messages.chars),
      summaryChunkCount: Number(summaries.count),
      summarizedMessageCount: Number(summaries.messages),
      lastRun: lastRunRow ? this.mapContextRun(lastRunRow) : null
    };
  }

  enqueueJob(roomId: string, sourceMessageId: number, agentId: string, depth: number): Job | null {
    const createdAt = now();
    const result = this.sqlite.prepare(`
      INSERT OR IGNORE INTO jobs (room_id, source_message_id, agent_id, depth, status, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?)
    `).run(roomId, sourceMessageId, agentId, depth, createdAt);
    if (result.changes === 0) return null;
    return this.getJob(Number(result.lastInsertRowid));
  }

  claimNextJob(roomId: string): Job | null {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const row = this.sqlite.prepare("SELECT id FROM jobs WHERE room_id = ? AND status = 'queued' ORDER BY id LIMIT 1").get(roomId) as { id: number } | undefined;
      if (!row) {
        this.sqlite.exec("COMMIT");
        return null;
      }
      this.sqlite.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(now(), row.id);
      this.sqlite.exec("COMMIT");
      return this.getJob(row.id);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  completeJob(jobId: number): Job {
    this.sqlite.prepare("UPDATE jobs SET status = 'completed', completed_at = ?, error = NULL WHERE id = ?").run(now(), jobId);
    return this.getJob(jobId);
  }

  failJob(jobId: number, error: string): Job {
    this.sqlite.prepare("UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(now(), error.slice(0, 500), jobId);
    return this.getJob(jobId);
  }

  listQueuedRooms(): string[] {
    return (this.sqlite.prepare("SELECT DISTINCT room_id FROM jobs WHERE status = 'queued'").all() as { room_id: string }[]).map((row) => row.room_id);
  }

  private getJob(jobId: number): Job {
    const row = this.sqlite.prepare(`
      SELECT j.*, a.username AS agent_username FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = ?
    `).get(jobId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Job not found.");
    return this.mapJob(row);
  }

  private cleanUsername(value: string): string {
    const username = value.toLowerCase().trim().replace(/^@/, "");
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(username)) throw new Error("Username must be 2 to 32 lowercase letters, numbers, or hyphens.");
    return username;
  }

  private mapUser(row: Record<string, unknown>): User {
    return { id: String(row.id), username: String(row.username), displayName: String(row.display_name), createdAt: String(row.created_at) };
  }

  private mapRoom(row: Record<string, unknown>): Room {
    return {
      id: String(row.id), slug: String(row.slug), name: String(row.name), projectBrief: String(row.project_brief),
      createdBy: String(row.created_by), createdAt: String(row.created_at)
    };
  }

  private mapAgent(row: Record<string, unknown>): Agent {
    const agent: Agent = {
      id: String(row.id), username: String(row.username), displayName: String(row.display_name), provider: row.provider as Provider,
      baseUrl: String(row.base_url), model: String(row.model), apiKeyEnv: String(row.api_key_env), systemPrompt: String(row.system_prompt),
      enabled: Boolean(row.enabled), createdBy: String(row.created_by), createdAt: String(row.created_at)
    };
    return row.position === undefined ? agent : { ...agent, position: Number(row.position) };
  }

  private mapMessage(row: Record<string, unknown>): Message {
    return {
      id: Number(row.id), roomId: String(row.room_id), authorType: row.author_type as Message["authorType"],
      authorId: row.author_id === null ? null : String(row.author_id), authorUsername: String(row.author_username),
      content: String(row.content), parentMessageId: row.parent_message_id === null ? null : Number(row.parent_message_id),
      aiDepth: Number(row.ai_depth), createdAt: String(row.created_at)
    };
  }

  private mapJob(row: Record<string, unknown>): Job {
    const job: Job = {
      id: Number(row.id), roomId: String(row.room_id), sourceMessageId: Number(row.source_message_id), agentId: String(row.agent_id),
      depth: Number(row.depth), status: row.status as Job["status"],
      error: row.error === null ? null : String(row.error), createdAt: String(row.created_at),
      startedAt: row.started_at === null ? null : String(row.started_at), completedAt: row.completed_at === null ? null : String(row.completed_at)
    };
    return row.agent_username === undefined ? job : { ...job, agentUsername: String(row.agent_username) };
  }

  private mapContextSummary(row: Record<string, unknown>): ContextSummary {
    return {
      id: Number(row.id), roomId: String(row.room_id), startMessageId: Number(row.start_message_id),
      endMessageId: Number(row.end_message_id), messageCount: Number(row.message_count),
      summary: String(row.summary), createdAt: String(row.created_at)
    };
  }

  private mapContextRun(row: Record<string, unknown>): ContextRun {
    return {
      id: Number(row.id), jobId: Number(row.job_id), roomId: String(row.room_id), totalMessages: Number(row.total_messages),
      recentMessages: Number(row.recent_messages), retrievedMessages: Number(row.retrieved_messages),
      summaryChunks: Number(row.summary_chunks), includedChars: Number(row.included_chars),
      archiveSearches: Number(row.archive_searches), createdAt: String(row.created_at)
    };
  }
}
