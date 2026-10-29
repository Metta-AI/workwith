// Until October 22, 2026, a session's cost (meta.spend) left out its subagents'
// calls: server/session.ts skipped their messages before it counted them. This
// adds them once, from Codinger's copy of the transcripts (server/archive.ts),
// which keeps the subagents' transcripts after Claude Code deletes them. It
// counts only the calls made before the server first ran the fix, and none
// made before the session's spend began.

import fs from 'node:fs'
import path from 'node:path'
import { DATA, readEvents } from './store.ts'
import { ARCHIVE, files, readLines } from './archive.ts'
import { costOf, WEEK } from '../shared/prices.ts'
import type { SessionMeta } from '../shared/types.ts'

// Between the last call of the last server run without the fix (11:56 UTC) and the first call of the next run (14:07 UTC).
const FIXED = Date.parse('2026-10-22T13:00:00Z')
const DONE = path.join(DATA, 'subagent-spend.json')
const HOUR = 3_600_000

// csid → its subagents' folders in the copy, one for each project folder it ran in.
async function folders(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const p of await fs.promises.readdir(ARCHIVE).catch(() => [] as string[])) {
    for (const c of await fs.promises.readdir(path.join(ARCHIVE, p)).catch(() => [] as string[])) {
      const dir = path.join(ARCHIVE, p, c, 'subagents')
      if (fs.existsSync(dir)) out.set(c, [...out.get(c) ?? [], dir])
    }
  }
  return out
}

// The subagents' calls of one session, with their time and cost.
export async function subagentCalls(m: SessionMeta, dirs: Map<string, string[]>): Promise<{ t: number; usd: number }[]> {
  const csids = new Set([m.claudeSessionId, ...readEvents(m.id).map((e) => (e as { csid?: string }).csid)].filter((x): x is string => !!x))
  const since = m.spend?.since ?? Infinity
  // A message's blocks come as separate lines with the usage so far, and a fork copies them: keep the largest.
  const calls = new Map<string, { t: number; usd: number }>()
  for (const c of csids) {
    for (const dir of dirs.get(c) ?? []) {
      for (const f of await files(dir, 4)) {
        await readLines(f, 0, (lines) => {
          for (const line of lines) {
            if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
            let x: any
            try { x = JSON.parse(line) } catch { continue }
            const msg = x.message, t = Date.parse(x.timestamp)
            if (x.type !== 'assistant' || !msg?.usage || !msg.id || msg.model === '<synthetic>') continue
            if (!(t >= since && t < FIXED)) continue
            const usd = costOf(msg.usage, msg.model)
            if (usd > (calls.get(msg.id)?.usd ?? 0)) calls.set(msg.id, { t, usd })
          }
        }).catch(() => 0)
      }
    }
  }
  return [...calls.values()]
}

export async function backfillSubagentSpend(metas: SessionMeta[], changed: () => void) {
  if (fs.existsSync(DONE)) return
  const dirs = await folders(), added: Record<string, number> = {}
  for (const m of metas) {
    if (!m.spend) continue
    const calls = await subagentCalls(m, dirs)
    if (!calls.length) continue
    const now = Date.now(), s = m.spend, hours = new Map(s.hours ?? [])
    let usd = 0
    for (const c of calls) {
      usd += c.usd
      const h = Math.floor(c.t / HOUR) * HOUR
      if (h > now - WEEK - HOUR) hours.set(h, (hours.get(h) ?? 0) + c.usd)
    }
    m.spend = { ...s, usd: s.usd + usd, hours: [...hours].sort((a, b) => a[0] - b[0]) }
    added[m.id] = Math.round(usd * 100) / 100
  }
  fs.writeFileSync(DONE, JSON.stringify({ at: Date.now(), fixed: FIXED, added }, null, 1))
  changed()
}
