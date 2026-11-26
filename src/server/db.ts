import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Agent, Job, Message, Provider, Room, RoomSnapshot, RoomSummary, User } from "./types.js";

const now = () => new Date().toISOString();
const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48);

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
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
    `);
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
    const agents = this.listRoomAgents(roomId).map((agent) => ({ ...agent, configured: Boolean(process.env[agent.apiKeyEnv]) }));
    const jobs = (this.sqlite.prepare(`
      SELECT j.*, a.username AS agent_username FROM jobs j JOIN agents a ON a.id = j.agent_id
      WHERE j.room_id = ? ORDER BY j.id DESC LIMIT 20
    `).all(roomId) as Record<string, unknown>[]).map((row) => this.mapJob(row));
    return { room: this.getRoom(roomId), messages, members, agents, jobs };
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
    if (!url.protocol.startsWith("http")) throw new Error("Model URL must use HTTP or HTTPS.");
    if (!/^[A-Z][A-Z0-9_]*$/.test(input.apiKeyEnv)) throw new Error("API key environment variable is invalid.");
    const agent: Agent = {
      id: randomUUID(),
      username,
      displayName: input.displayName.trim(),
      provider: input.provider,
      baseUrl: url.toString().replace(/\/$/, ""),
      model: input.model.trim(),
      apiKeyEnv: input.apiKeyEnv,
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
    return { ...agent, position: positionRow.position, configured: Boolean(process.env[agent.apiKeyEnv]) };
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

  listContextMessages(roomId: string, maxChars: number): Message[] {
    const rows = this.sqlite.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 400").all(roomId) as Record<string, unknown>[];
    const selected: Message[] = [];
    let used = 0;
    for (const row of rows) {
      const message = this.mapMessage(row);
      const cost = message.content.length + message.authorUsername.length + 8;
      if (selected.length > 0 && used + cost > maxChars) break;
      selected.push(message);
      used += cost;
    }
    return selected.reverse();
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
}
