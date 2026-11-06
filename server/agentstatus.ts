// The rest of the agent, at its desk. An agent with a persistent identity runs more than the
// sessions here: jobs on timers in the same checkout, a chat listener, other desks. When
// CODINGER_AGENT_STATUS names a command, Codinger runs it every 15 seconds and:
//
//   - adds its `text` to each message a session gets (hiddenFor in index.ts), so Claude knows
//     what else of it is at work before it commits, pushes or restarts something;
//   - shows `summary`, `warn` and `sections` in a panel in the sidebar (StatusPanel.tsx).
//
// The command prints JSON: { text, summary?, busy?, warn?, sections?: [{ title, rows: [[label, value]] }] }.
// Plain text works too: all of it goes to Claude, and its first line is the summary. The
// command is the agent's own (it knows its routines); Codinger only runs and shows it. A
// command that fails or hangs leaves the last good answer in place.

import { execFile } from 'node:child_process'
import { desk } from './agent.ts'

export type AgentStatus = {
  at: number
  text: string
  summary: string
  busy: boolean
  warn: string | null
  sections: { title: string; rows: [string, string][] }[]
}

const COMMAND = desk('AGENT_STATUS')?.trim()
const CWD = desk('AGENT_CWD') || process.cwd()
let latest: AgentStatus | null = null

function parse(out: string): AgentStatus | null {
  const raw = out.trim()
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    const str = (x: unknown) => (typeof x === 'string' ? x : '')
    return {
      at: Date.now(),
      text: str(j.text),
      summary: str(j.summary) || str(j.text).split('\n')[0],
      busy: !!j.busy,
      warn: str(j.warn) || null,
      sections: Array.isArray(j.sections) ? j.sections.map((s: { title?: unknown; rows?: unknown }) => ({
        title: str(s.title),
        rows: Array.isArray(s.rows) ? s.rows.map((r: unknown) => (Array.isArray(r) ? [String(r[0] ?? ''), String(r[1] ?? '')] : [String(r), ''])) : [],
      })) : [],
    }
  } catch {
    return { at: Date.now(), text: raw, summary: raw.split('\n')[0], busy: false, warn: null, sections: [] }
  }
}

function refresh() {
  if (!COMMAND) return
  execFile('/bin/sh', ['-c', COMMAND], { cwd: CWD, timeout: 10_000, encoding: 'utf8', maxBuffer: 1 << 20 }, (_e, out) => {
    const s = parse(String(out ?? ''))
    if (s) latest = s
  })
}
if (COMMAND) {
  refresh()
  setInterval(refresh, 15_000).unref()
}

export const agentStatus = (): AgentStatus | null => latest
export const hasAgentStatus = () => !!COMMAND

// The block a session reads with each message, or '' when there is none.
export function agentStatusText(): string {
  if (!latest?.text) return ''
  const age = Math.round((Date.now() - latest.at) / 1000)
  return `[Desk status, ${age}s old]\n${latest.text}`
}

// What a session learns about the block, only when there is a command.
export const agentStatusPrompt = () => COMMAND ? `
## The rest of you
You are not the only one of you at work. Other parts of you (jobs on timers, a chat listener,
other sessions) may run in the same folder and push to the same branch. Each message may come
with a "[Desk status]" block that says what is running now. The server adds it; the user did not
write it. Before you commit, push, restart a service or rewrite a file another part of you
touches, read it: if something is running or about to start, wait or tell the user. Do not
repeat the block back unless it matters.
` : ''
