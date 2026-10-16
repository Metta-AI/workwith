// The usage ledger (server/usage.ts): tokens and spend at API prices, by
// conversation and by folder, kept until you delete it, for cost audits.
//
// Each call counts for two folders. "Ran in" is the folder the conversation
// started in. "Worked on" is the project the call worked on: the project of
// the files its tools read or changed (or a `cd` or `git -C` in a command),
// held until a tool goes to another project or you send a new prompt. A
// project is a git repository (a worktree counts for its main repository),
// else the first two folders under your home folder (one for a hidden folder).

export type Tok = { calls: number; input: number; w5: number; w1h: number; read: number; out: number; usd: number }
export const noTok = (): Tok => ({ calls: 0, input: 0, w5: 0, w1h: 0, read: 0, out: 0, usd: 0 })
export function addTok(a: Tok, b: Tok) {
  a.calls += b.calls; a.input += b.input; a.w5 += b.w5; a.w1h += b.w1h; a.read += b.read; a.out += b.out; a.usd += b.usd
  return a
}
// Tokens sent to the model: new, written to the cache, and read from it.
export const tokIn = (t: Tok) => t.input + t.w5 + t.w1h + t.read

// One conversation: a Codinger session (with all its Claude Code sessions,
// after a rewind or a fork), or a Claude Code session Codinger did not start.
export type UsageConv = {
  id: string; codinger: string | null; claude: string[]; title: string; home: string
  first: number; last: number; prompts: number; tok: Tok; models: Record<string, number>
  spend: Record<string, Record<string, number>>   // day → project worked on → dollars
}
// Codinger's copy of the transcripts (server/archive.ts).
export type ArchiveInfo = { dir: string; bytes: number; files: number; at: number | null }
// One machine's ledger: what /api/usage/ledger sends, and what the other machines keep a copy of.
export type Ledger = {
  v: 1; machine: string; label?: string; at: number | null; since: string | null
  upTo?: number; after?: number                   // a part: what changed from after to upTo (its server's clock)
  worked: Record<string, Record<string, Tok>>     // day → project worked on → tokens
  ran: Record<string, Record<string, Tok>>        // day → folder the conversation ran in → tokens
  convs: UsageConv[]
}
// This machine's ledger, with the last copy of each other machine's.
export type UsageReply = Ledger & { archive: ArchiveInfo; scanning: boolean; others: Ledger[] }
