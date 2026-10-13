// API prices, in dollars per million tokens, by model. The usage meter weighs
// spend with them (server/meter.ts): your plan's limits are not in tokens, but
// a model's price is the best guess at how much of them its tokens use. A cache
// write costs 1.25× input (5-minute TTL) or 2× (1-hour TTL) on every model.
//
// What a call cost is worked out once, when it is made, and kept in dollars
// (the meter's log, a session's spend, notes.jsonl), so a later price change
// leaves the record as it was. When a price changes, add a dated entry here
// rather than editing the old one.

export type Price = { input: number; output: number; read: number }

// Each model's prices, oldest first, from the date (UTC) they apply.
// The first pattern that matches wins, so a longer name goes before its prefix.
const PRICES: [RegExp, [string, Price][]][] = [
  [/(fable|mythos)-5-1/, [['2026-10-06', { input: 10, output: 50, read: 0.25 }]]],
  [/fable|mythos/, [['2026-10-06', { input: 10, output: 50, read: 1 }]]],
  [/opus-5-5/, [['2026-10-06', { input: 4, output: 20, read: 0.2 }]]],
  [/opus/, [['2026-10-06', { input: 5, output: 25, read: 0.5 }]]],
  [/sonnet-4/, [['2026-10-06', { input: 3, output: 15, read: 0.3 }]]],
  [/sonnet/, [['2026-10-06', { input: 2, output: 10, read: 0.2 }]]],
  // Haiku 5.5 costs 5× as much for prompts over 100k tokens: see priceOf.
  [/haiku-5-5/, [['2026-10-06', { input: 0.1, output: 0.5, read: 0.01 }]]],
  [/haiku/, [['2026-10-06', { input: 1, output: 5, read: 0.1 }]]],
]
// A model this table doesn't know yet: priced like the default model.
const DEFAULT = /opus-5-5/

export function priceOf(model: string | null | undefined, prompt = 0, at = Date.now()): Price {
  const name = model ?? ''
  const list = (PRICES.find(([re]) => re.test(name)) ?? PRICES.find(([re]) => re.source === DEFAULT.source)!)[1]
  const day = new Date(at).toISOString().slice(0, 10)
  const p = (list.findLast(([from]) => from <= day) ?? list[0])[1]
  return /haiku-5-5/.test(name) && prompt > 100_000 ? { input: p.input * 5, output: p.output * 5, read: p.read * 5 } : p
}

// What one API call's usage cost, in dollars at API prices.
export function costOf(u: any, model: string | null | undefined): number {
  const cc = u.cache_creation ?? {}
  const w1h = cc.ephemeral_1h_input_tokens ?? 0
  const w5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h)
  const read = u.cache_read_input_tokens ?? 0, input = u.input_tokens ?? 0
  const p = priceOf(model, input + w5 + w1h + read)
  return (p.input * (input + 1.25 * w5 + 2 * w1h) + p.read * read + p.output * (u.output_tokens ?? 0)) / 1e6
}

type Spend = { usd: number; since: number; keep?: number; hours?: [number, number][] }
const HOUR = 3_600_000

// Add a call's cost to a session's total; keep: a notes or keep-warm call.
export function addSpend(m: { spend?: Spend }, usd: number, keep = false) {
  const now = Date.now(), hour = Math.floor(now / HOUR) * HOUR
  const s = m.spend ?? { usd: 0, since: now }
  const hours = (s.hours ?? []).filter(([t]) => t > now - WEEK - HOUR)
  const last = hours.at(-1)
  if (last?.[0] === hour) last[1] += usd
  else hours.push([hour, usd])
  m.spend = { ...s, usd: s.usd + usd, ...(keep || s.keep ? { keep: (s.keep ?? 0) + (keep ? usd : 0) } : {}), hours }
}

// What a session spent in the last `ms` (whole hours, so a little more than that).
// A session younger than that spent all it ever has: hours were kept for only 6 until October 2026.
export const WEEK = 7 * 24 * HOUR
export const recentSpend = (m: { spend?: Spend }, ms: number, now = Date.now()) =>
  m.spend && m.spend.since > now - ms ? m.spend.usd
  : (m.spend?.hours ?? []).filter(([t]) => t + HOUR > now - ms).reduce((x, [, d]) => x + d, 0)

// The same tokens sent with no cache at all, at the model's input price.
export const freshCost = (tokens: number, model: string | null | undefined) => tokens * priceOf(model, tokens).input / 1e6

// Sending to a context of `tokens`: reading it from a warm cache, or writing it to a cold one.
export const warmCost = (tokens: number, model: string | null | undefined) => tokens * priceOf(model, tokens).read / 1e6
export const coldCost = (tokens: number, model: string | null | undefined, ttl: number) =>
  tokens * priceOf(model, tokens).input * (ttl >= 3_600_000 ? 2 : 1.25) / 1e6
