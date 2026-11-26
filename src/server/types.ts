export type AuthorType = "human" | "agent" | "system";
export type Provider = "openai" | "anthropic";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface Room {
  id: string;
  slug: string;
  name: string;
  projectBrief: string;
  createdBy: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  username: string;
  displayName: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  systemPrompt: string;
  enabled: boolean;
  configured?: boolean;
  position?: number;
  createdBy: string;
  createdAt: string;
}

export interface Message {
  id: number;
  roomId: string;
  authorType: AuthorType;
  authorId: string | null;
  authorUsername: string;
  content: string;
  parentMessageId: number | null;
  aiDepth: number;
  createdAt: string;
}

export interface Job {
  id: number;
  roomId: string;
  sourceMessageId: number;
  agentId: string;
  agentUsername?: string;
  depth: number;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RoomSummary {
  room: Room;
  lastMessage: string | null;
  lastMessageAt: string | null;
  memberCount: number;
  agentCount: number;
}

export interface RoomSnapshot {
  room: Room;
  messages: Message[];
  members: User[];
  agents: Agent[];
  jobs: Job[];
}
