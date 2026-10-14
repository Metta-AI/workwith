// Prompt cache warmth. Each API call reads the conversation from Anthropic's
// prompt cache and keeps it alive for its TTL (5 minutes or 1 hour; usage says
// which). A message sent after that writes the whole context to the cache again,
// at full price: Settings can make Codinger ask first when that is big.

import type { SessionMeta } from './types.ts'

export const DEFAULT_CACHE_GUARD = 50_000   // tokens; 0 turns the guard off
// The cache's clock starts when a call starts, a little before its reply arrives.
const MARGIN = 30_000

// Milliseconds until the cache expires (negative once it has), or null when
// there is nothing cached to lose. A session we have no record for yet (it
// predates this) counts from its last activity, with the TTL seen elsewhere.
export function cacheLeft(m: SessionMeta, now: number, fallbackTtl = 300_000): number | null {
  if (!m.started || !m.context.used) return null
  if (m.status === 'working' || m.status === 'permission') return m.cache?.ttl ?? fallbackTtl
  const at = m.cache?.at ?? m.lastActivity
  return at + (m.cache?.ttl ?? fallbackTtl) - MARGIN - now
}

// The longest TTL any session has used lately: a fair guess for sessions without one.
export const knownTtl = (sessions: SessionMeta[]) => Math.max(300_000, ...sessions.map((s) => s.cache?.ttl ?? 0))

export const ttlLabel = (ttl: number) => ttl >= 3_600_000 ? '1 hour' : `${Math.round(ttl / 60_000)} minutes`
