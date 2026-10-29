// Autopilot: you give a session a goal and a budget and go away. Each time a turn
// ends, Codinger tells Claude to go on, until the budget is spent, Claude ends it
// (an <autopilot-stop> line, shared/blocks.ts), or something needs you: an error,
// your Stop, a permission mode other than auto. It needs auto mode, since nobody
// is there to answer a permission prompt.
//
// A budget is in dollars at API prices or a share of the 5-hour or weekly limit.
// A share is the session's own spend times the meter's estimate of what a dollar
// uses (server/meter.ts); with no estimate yet, it is how far the limit itself
// moved since the start, which counts other sessions too. The budget is checked
// between turns, so the last turn can go a little over.

import type { Autopilot, BudgetUnit, Event, SessionMeta, Usage } from '../shared/types.ts'
import { autopilotStop } from '../shared/blocks.ts'

export const UNITS: BudgetUnit[] = ['usd', 'fiveHour', 'sevenDay']
export const AUTOPILOT_MODES = ['auto', 'bypassPermissions']

// Turns in a row with no tool call before autopilot ends: Claude is only talking.
const IDLE_TURNS = 2

export function startAutopilot(m: SessionMeta, o: { goal?: unknown; unit?: unknown; budget?: unknown }, usage: Usage): Autopilot {
  if (!AUTOPILOT_MODES.includes(m.permissionMode)) throw new Error('Autopilot needs auto mode: nobody is there to answer a permission prompt')
  const unit = UNITS.find((u) => u === o.unit)
  if (!unit) throw new Error(`unit must be one of ${UNITS.join(', ')}`)
  const budget = Number(o.budget)
  if (!(budget > 0) || (unit !== 'usd' && budget > 1)) throw new Error(unit === 'usd' ? 'The budget must be more than $0' : 'The budget must be a share between 0 and 1')
  const share = unit === 'usd' ? undefined : usage[unit]
  if (unit !== 'usd' && usage.rate?.[unit] == null && share == null) throw new Error('Codinger has no report of that limit yet. Use a dollar budget, or try again after a turn.')
  return { goal: String(o.goal ?? '').trim(), unit, budget, used: 0, from: { usd: m.spend?.usd ?? 0, ...(share != null ? { share } : {}) }, at: Date.now(), turns: 0, idle: 0 }
}

// The budget spent so far, in its unit.
export function usedOf(ap: Autopilot, m: SessionMeta, usage: Usage): number {
  const usd = Math.max(0, (m.spend?.usd ?? 0) - ap.from.usd)
  if (ap.unit === 'usd') return usd
  const r = usage.rate?.[ap.unit]
  if (r != null) return usd * r
  const now = usage[ap.unit]
  return now != null && ap.from.share != null ? Math.max(0, now - ap.from.share) : 0
}

export function amount(unit: BudgetUnit, x: number): string {
  if (unit === 'usd') return `$${x.toFixed(2)}`
  const p = x * 100
  return `${p < 1 ? +p.toFixed(2) : +p.toFixed(1)}% of the ${unit === 'fiveHour' ? '5-hour' : 'weekly'} limit`
}

// What the turn that just ended did: Claude's text and whether it called a tool.
function lastTurn(ev: Event[]): { text: string; tools: boolean } {
  let text = '', tools = false
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i]
    if (e.t === 'user') break
    if (e.t !== 'assistant') continue
    for (const b of e.blocks) {
      if (b.type === 'text') text = `${b.text}\n${text}`
      if (b.type === 'tool_use') tools = true
    }
  }
  return { text, tools }
}

// A turn ended: why autopilot ends now, or null to go on.
export function verdict(ap: Autopilot, m: SessionMeta, ev: Event[], usage: Usage, error: boolean): string | null {
  ap.used = usedOf(ap, m, usage)
  if (!AUTOPILOT_MODES.includes(m.permissionMode)) return 'the permission mode is no longer auto'
  if (error) return `the turn ended with an error${m.error ? `: ${m.error.slice(0, 200)}` : ''}`
  if (m.pendingCritical) return 'Claude left an item marked critical for the user'
  const turn = lastTurn(ev)
  const stop = autopilotStop(turn.text)
  if (stop != null) return `Claude stopped${stop ? `: ${stop}` : ''}`
  if (ap.used >= ap.budget) return 'the budget is spent'
  ap.idle = turn.tools ? 0 : ap.idle + 1
  if (ap.idle >= IDLE_TURNS) return `Claude called no tools in ${IDLE_TURNS} turns in a row`
  return null
}

const RULES = (ap: Autopilot) => `[Codinger autopilot] The user turned on autopilot for this session and is away. They will read what you write later, not now. Each time your turn ends, Codinger tells you to go on, until the budget is spent or you stop.

Goal: ${ap.goal || 'the task in this conversation so far.'}
Budget: ${amount(ap.unit, ap.budget)} in all, checked between turns.

- Work toward the goal on your own. Make the choices a careful engineer would make, and write down each one that matters, so the user can check it later.
- The goal is not to finish at any cost. Go only as far as what the user wants is clear. When you are truly unsure, or the next step is hard to undo (deleting data, pushing, publishing, spending money, contacting people), stop and ask.
- To stop, end your message with this line: <autopilot-stop reason="a few words"/>. Stop when the goal is done, when you are blocked, or when you need the user to decide. Put a question for the user in an <ask> above that line.
- A question that does not block you: write it as an <ask>, take the answer you think best, say which one, and go on. The user answers later.
- Do not keep yourself going with /loop, ScheduleWakeup or sleep timers; Codinger does that now. If you set any, cancel them. To wait for something slow, run it with start_task and notify "turn"; Codinger waits for it.
- Before the budget runs out, keep the work where the user can pick it up: your notes up to date, and what is done and what is not.`

// The message that tells Claude to go on: a short line you see, and the rules, which you don't.
export function nudge(ap: Autopilot): { text: string; hidden: string } {
  const left = Math.max(0, ap.budget - ap.used)
  const text = ap.turns === 0
    ? `Autopilot on${ap.goal ? `: ${ap.goal}` : ''}. Budget: ${amount(ap.unit, ap.budget)}.`
    : `Autopilot: go on. ${amount(ap.unit, left)} left of ${amount(ap.unit, ap.budget)}.`
  const hidden = ap.turns === 0 ? RULES(ap)
    : `[Codinger autopilot] Go on toward the goal${ap.goal ? ` (${ap.goal})` : ''}. When it is done, or you need the user, end with <autopilot-stop reason="…"/>.`
  return { text, hidden }
}
