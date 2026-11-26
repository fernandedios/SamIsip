import type { Response } from "express";

export interface RoomEvent {
  type: "message.created" | "job.updated" | "room.updated" | "presence.updated";
  roomId: string;
  data?: unknown;
}

export class EventHub {
  private readonly rooms = new Map<string, Set<Response>>();

  subscribe(roomId: string, response: Response): () => void {
    const clients = this.rooms.get(roomId) ?? new Set<Response>();
    clients.add(response);
    this.rooms.set(roomId, clients);
    return () => {
      clients.delete(response);
      if (clients.size === 0) this.rooms.delete(roomId);
    };
  }

  publish(event: RoomEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.rooms.get(event.roomId) ?? []) client.write(payload);
  }
}
