// A session's prompt cache as the page shows it (shared/cache.ts): how long it
// stays warm, and whether a send now would write a big context to it again.

import { useEffect, useState } from 'react'
import type { SessionMeta } from '../../shared/types.ts'
import { DEFAULT_CACHE_GUARD, cacheLeft, knownTtl } from '../../shared/cache.ts'
import { changed, state } from './store.ts'
import { WEEK, coldCost, freshCost, recentSpend, warmCost } from '../../shared/prices.ts'

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

// A cost as you chose to see it: dollars at API prices, or a share of your 5-hour
// or weekly limit, once the meter (server/meter.ts) has an estimate for that limit.
const LIMITS = { pct: { key: 'fiveHour', name: '5-hour limit', short: '5h' }, week: { key: 'sevenDay', name: 'weekly limit', short: '7d' } } as const
export const limitOf = (mode = state.money) => LIMITS[mode === 'week' ? 'week' : 'pct']
export function shareOf(dollars: number, mode = state.money): number | null {
  const r = state.usage.rate?.[limitOf(mode).key]
  return r == null ? null : dollars * r * 100
}
// What is left of that limit, in percent.
export function limitLeft(mode = state.money): number | null {
  const u = state.usage[limitOf(mode).key]
  return u == null ? null : Math.max(0, 100 - u * 100)
}

// "$0.12", "0.4% of 5h", "0.1% of 7d"; without an estimate yet, the share shows as "…%".
export function money(dollars: number, mode = state.money): string {
  if (mode === 'usd') return usd(dollars)
  const s = shareOf(dollars, mode)
  return `${s == null ? '…%' : pct(s)} of ${limitOf(mode).short}`
}

// The same in a sentence: "0.7% of your 5-hour limit", or "$1.60 at API prices".
export function moneyLong(dollars: number, mode = state.money): string {
  const s = mode === 'usd' ? null : shareOf(dollars, mode)
  return s == null ? `${usd(dollars)} at API prices` : `${pct(s)} of your ${limitOf(mode).name}`
}

// What a conversation has cost so far, as a label and a tooltip. Percent: its share
// of your 5-hour limit over the last 5 hours, and of your weekly limit over the last
// 7 days; dollars: everything since Codiner began to count.
export function spendOf(m: SessionMeta) {
  if (!m.spend?.usd) return null
  const r = state.usage.rate
  const recent = recentSpend(m, 5 * 3_600_000), week = recentSpend(m, WEEK)
  const share = r?.fiveHour == null ? null : recent * r.fiveHour * 100
  const weekShare = r?.sevenDay == null ? null : week * r.sevenDay * 100
  const label = state.money === 'usd' ? usd(m.spend.usd)
    : state.money === 'week' ? `${weekShare == null ? '…%' : pct(weekShare)} in 7d`
    : `${share == null ? '…%' : pct(share)} in 5h`
  const keep = m.spend.keep ? ` Notes and keep-warm calls: ${usd(m.spend.keep)}.` : ''
  const tip = `This session cost ${usd(m.spend.usd)} at API prices since ${new Date(m.spend.since).toLocaleDateString()}, each call at the price of that time.${keep}`
    + `\n\nLast 5 hours: ${usd(recent)}${share != null ? `, about ${pct(share)} of your 5-hour limit` : '. Codiner does not know the 5-hour limit in dollars yet'}.`
    + `\n\nLast 7 days: ${usd(week)}${weekShare != null ? `, about ${pct(weekShare)} of your weekly limit` : '. Codiner does not know the weekly limit in dollars yet'}.`
  return { label, tip }
}

const NEXT = { usd: 'pct', pct: 'week', week: 'usd' } as const
export function toggleMoney() {
  if (state.billing === 'api') return   // per-token billing: dollars are all there is
  state.money = NEXT[state.money]
  localStorage.setItem('codiner.money', JSON.stringify(state.money))
  changed()
}

export const pct = (x: number) => x < 0.1 ? '<0.1%' : x < 10 ? `${x.toFixed(1)}%` : `${Math.round(x)}%`

export const minutes = (ms: number) => ms < 60_000 ? '<1m' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms / 60_000) % 60}m`
