// A session's prompt cache as the page shows it (shared/cache.ts): how long it
// stays warm, and whether a send now would write a big context to it again.

import { useEffect, useState } from 'react'
import type { SessionMeta } from '../../shared/types.ts'
import { DEFAULT_CACHE_GUARD, cacheLeft, knownTtl } from '../../shared/cache.ts'
import { changed, state } from './store.ts'
import { coldCost, freshCost, recentSpend, warmCost } from '../../shared/prices.ts'

export function useNow(every = 15_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t) }, [every])
  return now
}

export function cacheOf(m: SessionMeta, now: number) {
  const ttl = m.cache?.ttl ?? knownTtl(state.sessions)
  const left = cacheLeft(m, now, ttl)
  const guard = state.settings.cacheGuard ?? DEFAULT_CACHE_GUARD
  const cold = left != null && left <= 0
  // A send now would re-cache more than you allowed without asking.
  const blocked = cold && !!guard && m.context.used >= guard
  // Writing to the cache costs 1.25× input (5 minutes) or 2× (1 hour); reading it, a
  // fraction of input that depends on the model (shared/prices.ts).
  const model = m.model?.includes('-') ? m.model : m.expectedModel ?? m.model
  const dollars = { cold: coldCost(m.context.used, model, ttl), warm: warmCost(m.context.used, model), fresh: freshCost(m.context.used, model) }
  const times = Math.round(dollars.cold / (dollars.warm || 1e-9))
  // The same in your 5-hour limit, once the meter (server/meter.ts) has an estimate.
  const r = state.usage.rate?.fiveHour
  const share = (dollars: number) => r == null ? null : dollars * r * 100
  const limit = {
    cold: share(dollars.cold),
    warm: share(dollars.warm),
    left: state.usage.fiveHour == null ? null : Math.max(0, 100 - state.usage.fiveHour * 100),
  }
  // Chat on here, or start a new session from the notes: after how many messages the new one costs less.
  const fresh = newChat(m, model, ttl)
  const here = cold ? dollars.cold : dollars.warm
  const after = fresh.first <= here ? 1 : dollars.warm > fresh.next ? 1 + Math.ceil((fresh.first - here) / (dollars.warm - fresh.next)) : null
  return { ttl, left, cold, blocked, times, limit, dollars, fresh: { ...fresh, after } }
}

// A new session from this one's notes: its first message writes Claude Code's system
// prompt and tools (less what other sessions have cached already) and the notes to the
// cache; each later message reads that much. Sizes from the sessions seen so far.
function newChat(m: SessionMeta, model: string | null | undefined, ttl: number) {
  const bases = state.sessions.flatMap((s) => s.base ? [s.base] : []).sort((a, b) => a.total - b.total)
  const base = bases[Math.floor(bases.length / 2)] ?? { total: 32_000, read: 16_000 }
  const tokens = base.total + (m.notes?.size ?? 0)
  return { tokens, first: warmCost(base.read, model) + coldCost(tokens - base.read, model, ttl), next: warmCost(tokens, model) }
}

// A cost as a share of sending the same tokens with no cache: "8% of a fresh send".
export const ofFresh = (dollars: number, fresh: number) => {
  const x = dollars / (fresh || 1e-9)
  return x >= 1.5 ? `${+x.toFixed(1)}× a fresh send` : `${pct(x * 100)} of a fresh send`
}

export const usd = (x: number) => x < 0.01 ? '<$0.01' : x < 100 ? `$${x.toFixed(2)}` : `$${Math.round(x)}`

// A cost as you chose to see it: a share of your 5-hour limit, dollars at API
// prices, or both. Without an estimate from the meter, a share shows as dollars.
// Without an estimate from the meter yet, the share shows as "…%".
export function money(dollars: number, share: number | null, mode = state.money): string {
  if (mode === 'usd') return usd(dollars)
  const p = share == null ? '…%' : pct(share)
  return mode === 'both' ? `${p} · ${usd(dollars)}` : p
}

// The same in a sentence: "0.7% of your 5-hour limit", "$1.60 at API prices", or both.
export function moneyLong(dollars: number, share: number | null, mode = state.money): string {
  const a = share == null ? null : `${pct(share)} of your 5-hour limit`, b = `${usd(dollars)} at API prices`
  if (mode === 'usd' || a == null) return b
  return mode === 'both' ? `${a} (${b})` : a
}

// What a conversation has cost so far, as a label and a tooltip. Percent: its share
// of your 5-hour limit over the last 5 hours; dollars: everything since Codiner began to count.
export function spendOf(m: SessionMeta) {
  if (!m.spend?.usd) return null
  const r = state.usage.rate?.fiveHour
  const recent = recentSpend(m, 5 * 3_600_000)
  const share = r == null ? null : recent * r * 100
  const p = `${share == null ? '…%' : pct(share)} in 5h`
  const label = state.money === 'usd' ? usd(m.spend.usd) : state.money === 'pct' ? p : `${usd(m.spend.usd)} · ${p}`
  const keep = m.spend.keep ? ` ${usd(m.spend.keep)} of that was notes and keep-warm calls.` : ''
  const tip = `This session has cost ${usd(m.spend.usd)} at API prices since ${new Date(m.spend.since).toLocaleDateString()}, each call priced when it was made.${keep}`
    + `\n\nIn the last 5 hours it cost ${usd(recent)}${share != null ? `, about ${pct(share)} of your 5-hour limit` : '. Codiner is still measuring how much of your 5-hour limit a dollar uses'}.`
    + '\n\nClick to show costs as a percentage, in dollars, or both.'
  return { label, tip }
}

const NEXT = { pct: 'usd', usd: 'both', both: 'pct' } as const
export function toggleMoney() {
  state.money = NEXT[state.money]
  localStorage.setItem('codiner.money', JSON.stringify(state.money))
  changed()
}

export const pct = (x: number) => x < 0.1 ? '<0.1%' : x < 10 ? `${x.toFixed(1)}%` : `${Math.round(x)}%`

export const minutes = (ms: number) => ms < 60_000 ? '<1m' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms / 60_000) % 60}m`
