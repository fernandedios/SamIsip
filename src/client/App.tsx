import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Agent, Job, Message, Room, RoomSnapshot, RoomSummary, User } from "./types";

const identityKey = "samisip.identity";

const relativeTime = (value: string | null) => {
  if (!value) return "New";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
};

const initials = (value: string) => value.split(/[\s-]+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

function Icon({ name, size = 18 }: { name: "plus" | "send" | "menu" | "users" | "close" | "info" | "chevron"; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    send: <><path d="m4 4 17 8-17 8 3-8-3-8Z" /><path d="M7 12h14" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    chevron: <><path d="m9 18 6-6-6-6" /></>
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg aria-hidden="true" width="25" height="25" viewBox="0 0 25 25" fill="none">
        <path d="M4 5.5h8.5a5 5 0 0 1 0 10H9l-5 4v-14Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M21 4.5h-6.5a5 5 0 0 0 0 10H17l4 3v-13Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
      <span className="text-[17px] font-medium tracking-[-0.02em]">SamIsip</span>
    </div>
  );
}

function Modal({ title, children, onClose, titleAsH1 = false }: { title: string; children: ReactNode; onClose?: () => void; titleAsH1?: boolean }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="flex items-center justify-between gap-4">
          {titleAsH1 ? <h1 id="modal-title" className="text-[18px] font-medium">{title}</h1> : <h2 id="modal-title" className="text-[18px] font-medium">{title}</h2>}
          {onClose && <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>}
        </div>
        {children}
      </section>
    </div>
  );
}

function IdentityModal({ onSubmit, busy }: { onSubmit: (username: string, displayName: string) => Promise<void>; busy: boolean }) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSubmit(username, displayName);
  };
  return (
    <Modal title="Join the workspace" titleAsH1>
      <p className="mt-2 text-sm text-muted">Choose how people and AI collaborators will see you in every room.</p>
      <form className="mt-6 grid gap-4" onSubmit={submit}>
        <label className="field-label">Your name<input autoFocus required minLength={2} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Sam" /></label>
        <label className="field-label">Username<input required minLength={2} pattern="[a-z0-9-]+" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="sam" /></label>
        <button className="primary-button mt-2" disabled={busy}>{busy ? "Joining…" : "Enter SamIsip"}</button>
      </form>
    </Modal>
  );
}

function RoomModal({ user, onClose, onCreated }: { user: User; onClose: () => void; onCreated: (room: Room) => void }) {
  const [name, setName] = useState("");
  const [projectBrief, setProjectBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      onCreated(await api<Room>("/api/rooms", { method: "POST", body: JSON.stringify({ name, projectBrief, userId: user.id }) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Start a project room" onClose={onClose}>
      <form className="mt-6 grid gap-4" onSubmit={(event) => void submit(event)}>
        <label className="field-label">Room name<input autoFocus required minLength={2} value={name} onChange={(event) => setName(event.target.value)} placeholder="Launch planning" /></label>
        <label className="field-label">Project brief<textarea rows={5} value={projectBrief} onChange={(event) => setProjectBrief(event.target.value)} placeholder="What is this room trying to decide or deliver?" /></label>
        <div className="flex justify-end gap-2"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create room"}</button></div>
      </form>
    </Modal>
  );
}

function AgentModal({ roomId, user, onClose, onCreated }: { roomId: string; user: User; onClose: () => void; onCreated: (agent: Agent) => void }) {
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [form, setForm] = useState({
    username: "ai-", displayName: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini",
    apiKeyEnv: "OPENAI_API_KEY", systemPrompt: ""
  });
  const [busy, setBusy] = useState(false);
  const changeProvider = (value: "openai" | "anthropic") => {
    setProvider(value);
    setForm((current) => ({
      ...current,
      baseUrl: value === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1",
      model: value === "openai" ? "gpt-4.1-mini" : "claude-sonnet-4-5",
      apiKeyEnv: value === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
    }));
  };
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const agent = await api<Agent>(`/api/rooms/${roomId}/agents`, {
        method: "POST", body: JSON.stringify({ ...form, provider, userId: user.id })
      });
      onCreated(agent);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add an AI collaborator" onClose={onClose}>
      <p className="mt-2 text-sm text-muted">Use an OpenAI-compatible or Anthropic-compatible endpoint. Keys stay in the server environment.</p>
      <form className="mt-6 grid gap-4" onSubmit={(event) => void submit(event)}>
        <div className="grid grid-cols-2 gap-3">
          <label className="field-label">Provider<select value={provider} onChange={(event) => changeProvider(event.target.value as typeof provider)}><option value="openai">OpenAI style</option><option value="anthropic">Anthropic style</option></select></label>
          <label className="field-label">Display name<input required value={form.displayName} onChange={(event) => update("displayName", event.target.value)} placeholder="Researcher" /></label>
        </div>
        <label className="field-label">Username<input required pattern="ai-[a-z0-9-]+" value={form.username} onChange={(event) => update("username", event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} /></label>
        <label className="field-label">Base URL<input required type="url" value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="field-label">Model<input required value={form.model} onChange={(event) => update("model", event.target.value)} /></label>
          <label className="field-label">Key environment variable<input required pattern="[A-Z][A-Z0-9_]*" value={form.apiKeyEnv} onChange={(event) => update("apiKeyEnv", event.target.value.toUpperCase())} /></label>
        </div>
        <label className="field-label">Role prompt<textarea rows={4} value={form.systemPrompt} onChange={(event) => update("systemPrompt", event.target.value)} placeholder="What perspective should this collaborator bring?" /></label>
        <div className="flex justify-end gap-2"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Adding…" : "Add collaborator"}</button></div>
      </form>
    </Modal>
  );
}

function Sidebar({ rooms, selectedId, user, open, onClose, onSelect, onNewRoom, onSwitchUser }: {
  rooms: RoomSummary[]; selectedId: string | null; user: User | null; open: boolean;
  onClose: () => void; onSelect: (id: string) => void; onNewRoom: () => void; onSwitchUser: () => void;
}) {
  return (
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
      <div className="flex h-12 items-center justify-between lg:h-auto"><Logo /><button className="icon-button sidebar-close-button" onClick={onClose} aria-label="Close navigation"><Icon name="close" /></button></div>
      <div className="mt-8 flex items-center justify-between px-2">
        <span className="text-xs text-muted">Project rooms</span>
        <button className="icon-button" onClick={onNewRoom} aria-label="New room"><Icon name="plus" size={16} /></button>
      </div>
      <nav className="mt-2 grid gap-1" aria-label="Project rooms">
        {rooms.map((item) => (
          <button key={item.room.id} className={`room-row ${selectedId === item.room.id ? "room-row-active" : ""}`} onClick={() => onSelect(item.room.id)}>
            <span className="room-mark">{initials(item.room.name)}</span>
            <span className="min-w-0 flex-1 text-left"><span className="block truncate text-sm font-medium">{item.room.name}</span><span className="mt-0.5 block truncate text-xs text-muted">{item.lastMessage ?? "No messages yet"}</span></span>
            <span className="text-[11px] text-muted">{relativeTime(item.lastMessageAt)}</span>
          </button>
        ))}
      </nav>
      <div className="mt-auto pt-8">
        <button className="user-row" onClick={onSwitchUser}>
          <span className="avatar avatar-human">{initials(user?.displayName ?? "Guest")}</span>
          <span className="min-w-0 flex-1 text-left"><span className="block truncate text-sm font-medium">{user?.displayName ?? "Join"}</span><span className="block truncate text-xs text-muted">@{user?.username ?? "guest"}</span></span>
          <Icon name="chevron" size={15} />
        </button>
      </div>
    </aside>
  );
}

function MentionText({ content }: { content: string }) {
  return <>{content.split(/(@[a-z0-9][a-z0-9-]{1,31})/gi).map((part, index) => part.startsWith("@") ? <span className="mention" key={`${part}-${index}`}>{part}</span> : part)}</>;
}

function MessageRow({ message, agents }: { message: Message; agents: Agent[] }) {
  if (message.authorType === "system") return <div className="system-message"><Icon name="info" size={15} /><span>{message.content}</span></div>;
  const agent = agents.find((item) => item.id === message.authorId);
  const name = agent?.displayName ?? message.authorUsername;
  return (
    <article className="message-row">
      <span className={`avatar ${message.authorType === "agent" ? "avatar-agent" : "avatar-human"}`}>{initials(name)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2"><h3 className="text-sm font-medium">{name}</h3><span className="text-xs text-muted">@{message.authorUsername}</span><time className="text-[11px] text-muted">{relativeTime(message.createdAt)}</time></div>
        <p className="message-copy"><MentionText content={message.content} /></p>
      </div>
    </article>
  );
}

function QueueStrip({ jobs }: { jobs: Job[] }) {
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running").reverse();
  const failed = jobs.find((job) => job.status === "failed");
  if (active.length === 0 && !failed) return null;
  return (
    <div className={`queue-strip ${failed && active.length === 0 ? "queue-error" : ""}`}>
      {active.length > 0 ? <><span className="working-dot" /><span>{active.map((job) => `@${job.agentUsername}`).join(", ")} {active.some((job) => job.status === "running") ? "is thinking" : "is queued"}</span></> : <><span className="error-dot" /><span>@{failed?.agentUsername} could not respond: {failed?.error}</span></>}
    </div>
  );
}

function Composer({ agents, disabled, onSend }: { agents: Agent[]; disabled: boolean; onSend: (content: string) => Promise<void> }) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!content.trim() || busy || disabled) return;
    setBusy(true);
    try {
      await onSend(content.trim());
      setContent("");
    } finally {
      setBusy(false);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  const mention = (name: string) => setContent((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@${name} `);
  return (
    <div className="composer-wrap">
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
        <button className="mention-chip" onClick={() => mention("all-ai")}>@all-ai</button>
        {agents.map((agent) => <button className="mention-chip" key={agent.id} onClick={() => mention(agent.username)}>@{agent.username}</button>)}
      </div>
      <div className="composer">
        <textarea aria-label="Message" rows={2} value={content} onKeyDown={keyDown} onChange={(event) => setContent(event.target.value)} placeholder="Write a message. Mention an AI when you want its response." />
        <button className="send-button" onClick={() => void submit()} disabled={!content.trim() || busy || disabled} aria-label="Send message"><Icon name="send" size={17} /></button>
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted"><span>Enter to send · Shift + Enter for a new line</span><span>{content.length.toLocaleString()} / 12,000</span></div>
    </div>
  );
}

function DetailsPanel({ snapshot, onAddAgent, onSaveBrief, open, onClose }: {
  snapshot: RoomSnapshot; onAddAgent: () => void; onSaveBrief: (brief: string) => Promise<void>; open: boolean; onClose: () => void;
}) {
  const [brief, setBrief] = useState(snapshot.room.projectBrief);
  const [editing, setEditing] = useState(false);
  useEffect(() => setBrief(snapshot.room.projectBrief), [snapshot.room.projectBrief]);
  const save = async () => {
    await onSaveBrief(brief);
    setEditing(false);
  };
  return (
    <aside className={`details-panel ${open ? "details-open" : ""}`}>
      <div className="flex items-center justify-between"><h2 className="text-base font-medium">Room context</h2><button className="icon-button details-close-button" onClick={onClose} aria-label="Close details"><Icon name="close" /></button></div>
      <section className="mt-6">
        <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Project brief</h3><button className="text-button" onClick={() => setEditing((value) => !value)}>{editing ? "Cancel" : "Edit"}</button></div>
        {editing ? <div className="mt-3"><textarea className="brief-editor" rows={7} value={brief} onChange={(event) => setBrief(event.target.value)} /><button className="primary-button mt-2 w-full" onClick={() => void save()}>Save brief</button></div> : <p className="mt-2 text-sm leading-6 text-muted">{snapshot.room.projectBrief || "No project brief yet."}</p>}
      </section>
      <section className="details-section">
        <div className="flex items-center justify-between"><h3 className="text-sm font-medium">AI collaborators</h3><button className="text-button" onClick={onAddAgent}>Add model</button></div>
        <div className="mt-3 grid gap-2">
          {snapshot.agents.map((agent) => (
            <div className="collaborator-row" key={agent.id}>
              <span className="avatar avatar-agent">{initials(agent.displayName)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent.displayName}</span><span className="block truncate text-xs text-muted">@{agent.username} · {agent.model}</span></span>
              <span className={`status-dot ${agent.configured ? "status-ready" : "status-missing"}`} title={agent.configured ? "Ready" : `Missing ${agent.apiKeyEnv}`} />
            </div>
          ))}
        </div>
      </section>
      <section className="details-section">
        <h3 className="text-sm font-medium">People</h3>
        <div className="mt-3 grid gap-2">{snapshot.members.map((member) => <div className="collaborator-row" key={member.id}><span className="avatar avatar-human">{initials(member.displayName)}</span><span><span className="block text-sm font-medium">{member.displayName}</span><span className="block text-xs text-muted">@{member.username}</span></span></div>)}</div>
      </section>
      <section className="details-section">
        <h3 className="text-sm font-medium">Context memory</h3>
        <p className="mt-2 text-sm leading-6 text-muted">The full transcript stays searchable. Recent turns remain verbatim while older history becomes cited digests and relevant excerpts.</p>
        <dl className="mt-3 grid gap-2 text-sm">
          <div className="key-value"><dt>Full log</dt><dd>{snapshot.contextStatus.fullMessageCount} messages</dd></div>
          <div className="key-value"><dt>Digest coverage</dt><dd>{snapshot.contextStatus.summarizedMessageCount} messages</dd></div>
          <div className="key-value"><dt>Digest chunks</dt><dd>{snapshot.contextStatus.summaryChunkCount}</dd></div>
          {snapshot.contextStatus.lastRun && <>
            <div className="key-value"><dt>Recent in last turn</dt><dd>{snapshot.contextStatus.lastRun.recentMessages}</dd></div>
            <div className="key-value"><dt>Archive matches</dt><dd>{snapshot.contextStatus.lastRun.retrievedMessages}</dd></div>
          </>}
        </dl>
      </section>
      <section className="details-section">
        <h3 className="text-sm font-medium">Mention routing</h3>
        <dl className="mt-3 grid gap-2 text-sm"><div className="key-value"><dt>Named model</dt><dd>@ai-name</dd></div><div className="key-value"><dt>Every model</dt><dd>@all-ai</dd></div><div className="key-value"><dt>Max handoff depth</dt><dd>3 turns</dd></div></dl>
      </section>
    </aside>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refreshRooms = async () => setRooms(await api<RoomSummary[]>("/api/rooms"));
  const loadRoom = async (id: string) => setSnapshot(await api<RoomSnapshot>(`/api/rooms/${id}`));

  const signIn = async (username: string, displayName: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ user: User; rooms: RoomSummary[] }>("/api/session", { method: "POST", body: JSON.stringify({ username, displayName }) });
      localStorage.setItem(identityKey, JSON.stringify({ username, displayName }));
      setUser(result.user);
      setRooms(result.rooms);
      const selected = roomId ?? result.rooms[0]?.room.id ?? null;
      setRoomId(selected);
      setIdentityOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem(identityKey);
    if (!saved && new URLSearchParams(window.location.search).has("preview")) {
      void signIn("sam", "Sam");
      return;
    }
    if (!saved) {
      setIdentityOpen(true);
      return;
    }
    try {
      const identity = JSON.parse(saved) as { username: string; displayName: string };
      void signIn(identity.username, identity.displayName);
    } catch {
      setIdentityOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!roomId || !user) return;
    void api(`/api/rooms/${roomId}/join`, { method: "POST", body: JSON.stringify({ userId: user.id }) });
    void loadRoom(roomId);
    const source = new EventSource(`/api/rooms/${roomId}/events`);
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void loadRoom(roomId);
        void refreshRooms();
      }, 90);
    };
    for (const eventName of ["message.created", "job.updated", "room.updated", "presence.updated"]) source.addEventListener(eventName, refresh);
    return () => {
      window.clearTimeout(timer);
      source.close();
    };
  }, [roomId, user?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [snapshot?.messages.length]);

  const selectRoom = (id: string) => {
    setRoomId(id);
    setMobileNav(false);
  };
  const send = async (content: string) => {
    if (!user || !roomId) return;
    setError(null);
    try {
      await api(`/api/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify({ userId: user.id, content }) });
      await loadRoom(roomId);
      await refreshRooms();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Message could not be sent.");
    }
  };
  const saveBrief = async (projectBrief: string) => {
    if (!roomId) return;
    await api(`/api/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify({ projectBrief }) });
    await loadRoom(roomId);
  };
  const switchUser = () => {
    localStorage.removeItem(identityKey);
    setIdentityOpen(true);
  };

  return (
    <div className="app-shell">
      <Sidebar rooms={rooms} selectedId={roomId} user={user} open={mobileNav} onClose={() => setMobileNav(false)} onSelect={selectRoom} onNewRoom={() => setRoomModalOpen(true)} onSwitchUser={switchUser} />
      <main className="conversation-shell">
        <header className="mobile-header"><button className="icon-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Icon name="menu" /></button><span className="truncate text-sm font-medium">{snapshot?.room.name ?? "SamIsip"}</span><button className="icon-button" onClick={() => setDetailsOpen(true)} aria-label="Open room details"><Icon name="users" /></button></header>
        {snapshot ? <>
          <header className="conversation-header">
            <div><h1>{snapshot.room.name}</h1><p>{snapshot.members.length} {snapshot.members.length === 1 ? "person" : "people"} and {snapshot.agents.length} AI collaborators share this context.</p></div>
            <button className="secondary-button conversation-detail-button" onClick={() => setDetailsOpen(true)}><Icon name="users" size={16} />Room details</button>
          </header>
          <div className="message-list">
            {snapshot.messages.map((message) => <MessageRow key={message.id} message={message} agents={snapshot.agents} />)}
            <QueueStrip jobs={snapshot.jobs} />
            <div ref={endRef} />
          </div>
          <Composer agents={snapshot.agents} disabled={!user} onSend={send} />
        </> : <div className="empty-screen"><Logo /><p>{rooms.length === 0 ? "Start a project room to bring your collaborators together." : "Opening the room…"}</p>{rooms.length === 0 && <button className="primary-button" onClick={() => setRoomModalOpen(true)}>Create a room</button>}</div>}
      </main>
      {snapshot && <DetailsPanel snapshot={snapshot} onAddAgent={() => setAgentModalOpen(true)} onSaveBrief={saveBrief} open={detailsOpen} onClose={() => setDetailsOpen(false)} />}
      {(mobileNav || detailsOpen) && <button className="panel-scrim" aria-label="Close panel" onClick={() => { setMobileNav(false); setDetailsOpen(false); }} />}
      {error && <div className="error-toast" role="alert">{error}<button onClick={() => setError(null)} aria-label="Dismiss"><Icon name="close" size={15} /></button></div>}
      {identityOpen && <IdentityModal onSubmit={signIn} busy={busy} />}
      {roomModalOpen && user && <RoomModal user={user} onClose={() => setRoomModalOpen(false)} onCreated={(room) => { setRoomModalOpen(false); void refreshRooms(); selectRoom(room.id); }} />}
      {agentModalOpen && user && roomId && <AgentModal roomId={roomId} user={user} onClose={() => setAgentModalOpen(false)} onCreated={() => { setAgentModalOpen(false); void loadRoom(roomId); }} />}
    </div>
  );
}
