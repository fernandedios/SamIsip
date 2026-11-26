import type { AppDatabase } from "./db.js";
import type { EventHub } from "./events.js";
import type { ProviderClient } from "./providers.js";
import type { Message } from "./types.js";

export const parseMentions = (content: string): Set<string> => {
  const names = new Set<string>();
  for (const match of content.matchAll(/(^|[^a-z0-9_-])@([a-z0-9][a-z0-9-]{1,31})\b/gi)) {
    const name = match[2]?.toLowerCase();
    if (name) names.add(name);
  }
  return names;
};

export class QueueManager {
  private readonly activeRooms = new Set<string>();

  constructor(
    private readonly db: AppDatabase,
    private readonly events: EventHub,
    private readonly providers: ProviderClient,
    private readonly maxDepth: number,
    private readonly maxContextChars: number
  ) {}

  resume(): void {
    for (const roomId of this.db.listQueuedRooms()) this.kick(roomId);
  }

  dispatch(message: Message): number {
    if (message.aiDepth >= this.maxDepth) return 0;
    const mentions = parseMentions(message.content);
    const agents = this.db.listRoomAgents(message.roomId).filter((agent) => agent.enabled && agent.id !== message.authorId);
    const targets = mentions.has("all-ai") ? agents : agents.filter((agent) => mentions.has(agent.username));
    let queued = 0;
    for (const agent of targets) {
      const job = this.db.enqueueJob(message.roomId, message.id, agent.id, message.aiDepth + 1);
      if (!job) continue;
      queued += 1;
      this.events.publish({ type: "job.updated", roomId: message.roomId, data: job });
    }
    if (queued > 0) this.kick(message.roomId);
    return queued;
  }

  private kick(roomId: string): void {
    if (this.activeRooms.has(roomId)) return;
    this.activeRooms.add(roomId);
    queueMicrotask(() => void this.runRoom(roomId));
  }

  private async runRoom(roomId: string): Promise<void> {
    try {
      for (;;) {
        const job = this.db.claimNextJob(roomId);
        if (!job) return;
        this.events.publish({ type: "job.updated", roomId, data: job });
        try {
          const agent = this.db.getAgent(job.agentId);
          const room = this.db.getRoom(roomId);
          const history = this.db.listContextMessages(roomId, this.maxContextChars);
          const response = await this.providers.generate(agent, room, history, this.db.listRoomAgents(roomId));
          const message = this.db.insertMessage({
            roomId,
            authorType: "agent",
            authorId: agent.id,
            authorUsername: agent.username,
            content: response,
            parentMessageId: job.sourceMessageId,
            aiDepth: job.depth
          });
          this.events.publish({ type: "message.created", roomId, data: message });
          this.events.publish({ type: "job.updated", roomId, data: this.db.completeJob(job.id) });
          this.dispatch(message);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown model error.";
          this.events.publish({ type: "job.updated", roomId, data: this.db.failJob(job.id, message) });
        }
      }
    } finally {
      this.activeRooms.delete(roomId);
      if (this.db.listQueuedRooms().includes(roomId)) this.kick(roomId);
    }
  }
}
