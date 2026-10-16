// Everything the server and the browser both speak. The server keeps one
// append-only event log per session; the browser folds it into a transcript.

import type { Look } from './looks.ts'
import type { Appearance } from './appearance.ts'

export type Status =
  | 'new'        // never sent anything
  | 'working'    // a turn is in flight
  | 'permission' // blocked on you approving a tool call
  | 'asking'     // finished, and left questions for you
  | 'waiting'    // finished, and you haven't looked yet
  | 'idle'       // finished, seen
  | 'error'

export type PermissionMode = 'auto' | 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

// What the lead drafted for a session, in the shape of your own replies: a
// message, an answer to an <ask>, a reply to a <consider> item, or one marked
// done or set aside. key: the item ("<msg>:<id>"); label: its question or title.
// Drafts from before October 2026 have no kind: they are messages.
export type InboxItem = {
  id: string; text: string; from: string; ts: number
  kind?: 'text' | 'answer' | 'reply' | 'done' | 'dismiss'
  key?: string; label?: string; choices?: string[]; draft?: 'same' | 'edited'
}

export type SessionMeta = {
  id: string
  kind: 'worker' | 'lead'
  title: string
  cwd: string
  parentId: string | null
  model: string | null
  permissionMode: PermissionMode
  claudeSessionId: string
  started: boolean        // the claude session exists on disk, so we --resume it
  createdAt: number
  lastActivity: number
  status: Status
  running: boolean        // a claude process is alive for it right now
  unread: boolean
  compacting: boolean
  context: { used: number; window: number }
  pendingAsks: number
  lastText: string        // the tail of the last thing Claude said, for overviews
  error: string | null
  archived: boolean
  inbox: InboxItem[]      // replies the lead agent drafted for this session
  drafting?: boolean      // you have a reply in progress here (the browser says so), so the lead's wait
  look?: Look             // what its critter wears; Claude picks it (shared/looks.ts)
  titleByUser?: boolean   // you named it at some point
  // Claude renamed a session you had named: your name, to undo to; and a name of Claude's you undid.
  titleBefore?: string
  titleUndone?: string
  order?: number          // its place among its siblings in the sidebar, once dragged there
  // The prompt cache: when the last API call started (at the latest), and its TTL (ms). See shared/cache.ts.
  cache?: { at: number; ttl: number }
  notes?: NotesState
  // What its API calls cost (notes and keep-warm included), in dollars at API prices,
  // each priced when it was made (shared/prices.ts); since: when Codiner began to count.
  // keep: the part notes and keep-warm calls cost; hours: [hour start, dollars] for the last 7 days.
  spend?: { usd: number; since: number; keep?: number; hours?: [number, number][] }
  // The first API call's prompt: Claude Code's system prompt and tools, and how much of
  // it other sessions had already cached. What a new session would start from.
  base?: { total: number; read: number }
  // Started with your MCP servers off (server/mcpservers.ts); on: the ones turned on since;
  // missing: a server Claude asked for that Codiner doesn't know, until you press Refresh.
  mcp?: { strict: true; on: string[]; missing?: string }
  // The model it will probably run, until Claude Code reports the real one into model.
  expectedModel?: string
  // Set by a rewind: the next start resumes claudeSessionId cut at this entry, as a fork.
  resumeAt?: string | null
  held?: Held[]           // replies waiting for a joint turn (Held)
}

// Rolling notes on a session, and the keep-warm calls that keep its prompt cache
// alive while it waits for you (server/notes.ts).
export type NotesState = {
  at?: number              // when the notes file was last written
  upTo?: number            // the session's lastActivity that those notes cover
  running?: 'notes' | 'ping'
  quiet?: number           // the lastActivity this spell of quiet started at
  spent?: number           // dollars at API prices (shared/prices.ts) the calls cost in this spell
  calls?: number
  end?: { reason: string; at: number }  // keep-warm stopped for this spell; at: when the cache expires
  off?: string             // keep-warm stopped for this session until you turn it on again
  size?: number            // tokens in the notes, roughly
}

export type ImageRef = { url: string; mediaType: string }

// A quote's position inside one rendered message: per markdown block, the
// Marginer quote pieces (text runs + their occurrence numbers) in that block.
export type AnchorPiece = { block: number; quotes: string[]; nths: number[] }
export type Anchor = { msg: string; pieces: AnchorPiece[] }

// Who wrote something, when a proxy in front of Codiner names the signed-in person
// (CODINER_USER_HEADER; server/agent.ts). login: as the proxy gives it; name: to show.
// guest: the name came from the browser (CODINER_ASK_NAME), and nothing checked it.
export type Person = { login: string; name: string; guest?: boolean }

// The agent this Codiner belongs to, when it runs on an agent's own host (server/agent.ts):
// its name for "Message Synth", and whether it has a face and a theme of its own.
export type AgentInfo = { name: string; avatar: boolean; theme: boolean }

// by: who wrote the part, when Codiner knows people apart (see Person).
export type Part = ({ by?: Person }) & (
  | { kind: 'text'; text: string; images?: ImageRef[] }
  // itemKey: the <consider> item this comment replies to ("<msg>:<id>").
  // whole: a reaction to a whole paragraph or list item.
  | { kind: 'note'; text: string; quote: string; anchor: Anchor; images?: ImageRef[]; itemKey?: string; whole?: boolean }
  // draft: the answer to a <draft>, sent back as Claude wrote it or edited.
  | { kind: 'answer'; text: string; askKey: string; question: string; choices?: string[]; images?: ImageRef[]; draft?: 'same' | 'edited' }
  // Questions and items the user saw and set aside.
  | { kind: 'dismiss'; text: string; items: { key: string; label: string }[]; images?: ImageRef[] }
  // Items the user marked done; `text` on one is a problem they hit doing it.
  // result: how a command the item asked for went.
  | { kind: 'done'; text: string; items: { key: string; label: string; text?: string; result?: string }[]; images?: ImageRef[] }
)

// Replies someone held for a joint turn instead of sending them: they wait on the
// server, everyone sees them, and the next send from anyone takes them along.
export type Held = { id: string; by: Person | null; parts: Part[]; ts: number }

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }

type E<T extends string, B> = { seq: number; ts: number; t: T } & B

export type Event =
  // uuid: the id Claude Code gave the message in its transcript (we choose it);
  // csid: the Claude session it went to. A rewind cuts the transcript there.
  // by: who sent it (the parts say who wrote each, which differs in a joint turn).
  | E<'user', { parts: Part[]; from?: string; by?: Person; uuid?: string; csid?: string }>
  | E<'assistant', { msgId: string; blocks: Block[]; synthetic?: boolean }>
  | E<'tool_result', { toolUseId: string; text: string; isError: boolean }>
  | E<'permission', { requestId: string; toolName: string; input: any; description?: string; canAlways: boolean; toolUseId?: string }>
  | E<'permission_resolved', { requestId: string; resolution: 'allow' | 'always' | 'deny' | 'cancelled' }>
  | E<'notice', { text: string; level: 'info' | 'warn' | 'error' }>
  | E<'result', { durationMs: number; isError: boolean; text?: string }>

// Claude Code's login: 'pending' while `claude auth login` waits for you (url: its sign-in page).
export type AuthState = { state: 'ok' | 'needed' | 'pending' | 'failed'; url?: string; error?: string }

// rate: how much of each window a dollar of spend (at API prices) uses, as server/meter.ts estimates it.
// overage: extra usage paid for the call that sent this report.
export type Usage = { fiveHour?: number; sevenDay?: number; resetsAt?: number; status?: string; overage?: boolean; rate?: { fiveHour?: number; sevenDay?: number; pairs: number } }
// trackedFiles: files whose history Codiner keeps, besides AGENTS.md, CLAUDE.md and LEAD_NOTES.md.
// selfRestart: offer to restart when Codiner's own code changes (for working on Codiner); off by default.
// appearance: unset until you pick one, which the first load asks you to do.
// groupOrder: the sidebar's folders, once you drag one. cacheGuard: tokens; see shared/cache.ts.
// notes, keepWarmHours, keepWarmMax, keepWarmUsage: see server/notes.ts.
// plan: what you pay a month (yearly: you pay for a year, usd is that over 12), for the plan
// you confirmed it for. reviewSeen: the last weekly and monthly review you closed. See shared/costs.ts.
export type Settings = {
  leadAutoSend: boolean; autoModeMigrated?: boolean; trackedFiles?: string[]; selfRestart?: boolean
  appearance?: Appearance; groupOrder?: string[]; cacheGuard?: number
  notes?: boolean; keepWarmHours?: number; keepWarmMax?: number; keepWarmUsage?: number
  // MCP servers: new sessions start with them off (default), except those always on;
  // Claude may turn one on itself (default) or must ask you.
  mcpStartOff?: boolean; mcpAlways?: string[]; mcpClaude?: boolean
  plan?: { tier: string; usd: number; yearly?: boolean }; reviewSeen?: { week?: string; month?: string }
}

export type ServerMsg =
  // agent: set when Codiner runs as one agent's desk; me: who this browser is, per the proxy;
  // billing: 'api' when Claude Code bills per token (Bedrock, Vertex), so there are no plan limits.
  | { type: 'hello'; sessions: SessionMeta[]; settings: Settings; usage: Usage; platform: string; home: string; auth: AuthState; stale?: boolean
      agent?: AgentInfo; me?: Person | null; askName?: boolean; billing?: 'api' | 'plan' }
  | { type: 'auth'; auth: AuthState }
  // The server's code on disk is newer than the running server.
  | { type: 'stale'; stale: boolean }
  // A tracked file has a new version.
  | { type: 'file'; path: string }
  // A command run from a <run> block ended.
  | { type: 'run'; sessionId: string; token: string; code: number; tail: string }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'event'; sessionId: string; event: Event }
  | { type: 'delta'; sessionId: string; text: string; reset?: boolean }
  // Events from seq on are gone (a rewind).
  | { type: 'truncate'; sessionId: string; seq: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'settings'; settings: Settings }
  | { type: 'tasks'; tasks: Task[] }
  // Who has this page open now, once each (only people Codiner can name).
  | { type: 'people'; people: Person[] }

// A long-running command an agent started with start_task (server/tasks.ts).
// notify: how the agent hears that it ended: with its next message, in a turn of
// its own, or by stopping the turn it is in. told: it has heard.
export type TaskNotify = 'next' | 'turn' | 'interrupt'
export type Task = {
  id: string; sid: string; title: string; command: string; cwd: string; pid: number
  started: number; ended?: number; code?: number | null; stopped?: 'user' | 'agent'
  notify: TaskNotify; told?: boolean
}

export type SlashCommand = { name: string; description: string; argumentHint: string }
export type HistoryItem = {
  id: string; cwd: string; title: string; firstPrompt: string; lastPrompt: string
  mtime: number; size: number; continuedIn: string | null; codinerId: string | null
}
export type RecentDir = { path: string; ts: number; source: 'codiner' | 'claude' | 'both' }
export type DirListing = { path: string; parent: string | null; dirs: string[] }
