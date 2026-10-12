// Everything the server and the browser both speak. The server keeps one
// append-only event log per session; the browser folds it into a transcript.

import type { Look } from './looks.ts'

export type Status =
  | 'new'        // never sent anything
  | 'working'    // a turn is in flight
  | 'permission' // blocked on you approving a tool call
  | 'asking'     // finished, and left questions for you
  | 'waiting'    // finished, and you haven't looked yet
  | 'idle'       // finished, seen
  | 'error'

export type PermissionMode = 'auto' | 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export type InboxItem = { id: string; text: string; from: string; ts: number }

export type SessionMeta = {
  id: string
  kind: 'worker' | 'master'
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
  inbox: InboxItem[]      // messages the master agent drafted for this session
  look?: Look             // what its critter wears; Claude picks it (shared/looks.ts)
  // Set by a rewind: the next start resumes claudeSessionId cut at this entry, as a fork.
  resumeAt?: string | null
}

export type ImageRef = { url: string; mediaType: string }

// A quote's position inside one rendered message: per markdown block, the
// Marginer quote pieces (text runs + their occurrence numbers) in that block.
export type AnchorPiece = { block: number; quotes: string[]; nths: number[] }
export type Anchor = { msg: string; pieces: AnchorPiece[] }

export type Part =
  | { kind: 'text'; text: string; images?: ImageRef[] }
  // itemKey: the <consider> item this comment replies to ("<msg>:<id>").
  | { kind: 'note'; text: string; quote: string; anchor: Anchor; images?: ImageRef[]; itemKey?: string }
  | { kind: 'answer'; text: string; askKey: string; question: string; choices?: string[]; images?: ImageRef[] }
  // Questions and items the user saw and set aside.
  | { kind: 'dismiss'; text: string; items: { key: string; label: string }[]; images?: ImageRef[] }

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }

type E<T extends string, B> = { seq: number; ts: number; t: T } & B

export type Event =
  // uuid: the id Claude Code gave the message in its transcript (we choose it);
  // csid: the Claude session it went to. A rewind cuts the transcript there.
  | E<'user', { parts: Part[]; from?: string; uuid?: string; csid?: string }>
  | E<'assistant', { msgId: string; blocks: Block[]; synthetic?: boolean }>
  | E<'tool_result', { toolUseId: string; text: string; isError: boolean }>
  | E<'permission', { requestId: string; toolName: string; input: any; description?: string; canAlways: boolean; toolUseId?: string }>
  | E<'permission_resolved', { requestId: string; resolution: 'allow' | 'always' | 'deny' | 'cancelled' }>
  | E<'notice', { text: string; level: 'info' | 'warn' | 'error' }>
  | E<'result', { durationMs: number; isError: boolean; text?: string }>

export type Usage = { fiveHour?: number; sevenDay?: number; resetsAt?: number; status?: string }
export type Settings = { masterAutoSend: boolean; autoModeMigrated?: boolean }

export type ServerMsg =
  | { type: 'hello'; sessions: SessionMeta[]; settings: Settings; usage: Usage; platform: string; home: string }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'event'; sessionId: string; event: Event }
  | { type: 'delta'; sessionId: string; text: string; reset?: boolean }
  // Events from seq on are gone (a rewind).
  | { type: 'truncate'; sessionId: string; seq: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'settings'; settings: Settings }

export type SlashCommand = { name: string; description: string; argumentHint: string }
export type HistoryItem = {
  id: string; cwd: string; title: string; firstPrompt: string; lastPrompt: string
  mtime: number; size: number; continuedIn: string | null; codinerId: string | null
}
export type RecentDir = { path: string; ts: number; source: 'codiner' | 'claude' | 'both' }
export type DirListing = { path: string; parent: string | null; dirs: string[] }
