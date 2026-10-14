// A day-by-day record of what Claude Code spends at API prices, for the cost
// view and the reviews (shared/costs.ts). Claude Code deletes its transcripts
// after 30 days, so Codiner keeps the totals in costs.json.
//
// At start, the transcripts are read up to where the usage meter starts
// counting (server/meter.ts), and the meter adds what comes after. A day the
// transcripts still cover takes the larger of the two counts: the saved one
// and the one read again (both include what was spent while Codiner ran,
// and a deleted transcript only makes the count smaller).
//
// Extra usage comes from claude.ai, through the endpoint Claude Code's /usage
// reads, with Claude Code's own login. The login is only read: Codiner never
// renews it, since a renewal would end the one Claude Code holds.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { execFile } from 'node:child_process'
import { DATA } from './store.ts'
import { costOf } from '../shared/prices.ts'
import { PLANS, dayKey, type CostDay, type CostsReply, type Extra, type Plan } from '../shared/costs.ts'
import type { Usage } from '../shared/types.ts'
import { isPrompt, onCount, rate, startOffsets } from './meter.ts'

const FILE = path.join(DATA, 'costs.json')
const CONFIG = path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), '.claude.json')
type Saved = { v: 1; days: Record<string, CostDay>; extra?: Extra; extraMonths?: Record<string, number> }

const blank = (): CostDay => ({ usd: 0, prompts: 0, models: {}, hours: Array(24).fill(0) })
let saved: Saved = { v: 1, days: {} }
try { const x = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (x.v === 1) saved = x } catch {}
const first = saved.days                          // as saved when Codiner last ran
let base: Record<string, CostDay> = first          // then merged with the transcripts
const live: Record<string, CostDay> = {}          // counted since start
let scanning = false

function add(to: Record<string, CostDay>, t: number, usd: number, model: string) {
  const d = (to[dayKey(t)] ??= blank())
  d.usd += usd
  d.models[model] = (d.models[model] ?? 0) + usd
  d.hours[new Date(t).getHours()] += usd
}

export function days(): Record<string, CostDay> {
  const out: Record<string, CostDay> = {}
  for (const k of new Set([...Object.keys(base), ...Object.keys(live)])) {
    const a = base[k] ?? blank(), b = live[k]
    if (!b) { out[k] = a; continue }
    const models = { ...a.models }
    for (const m in b.models) models[m] = (models[m] ?? 0) + b.models[m]
    out[k] = {
      usd: a.usd + b.usd, prompts: a.prompts + b.prompts, models, hours: a.hours.map((h, i) => h + b.hours[i]),
      ...peaks(a, b),
    }
  }
  return out
}
const peaks = (a: CostDay, b: CostDay) => ({
  ...(a.five != null || b.five != null ? { five: Math.max(a.five ?? 0, b.five ?? 0) } : {}),
  ...(a.seven != null || b.seven != null ? { seven: Math.max(a.seven ?? 0, b.seven ?? 0) } : {}),
  ...(a.overage || b.overage ? { overage: true } : {}),
})

let timer: NodeJS.Timeout | null = null
function save() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    saved = { ...saved, days: days() }
    fs.writeFile(FILE, JSON.stringify(saved), () => {})
  }, 5_000)
}

// Read every transcript up to where the meter started.
async function scan() {
  scanning = true
  const offsets = startOffsets()
  const msgs = new Map<string, { t: number; usd: number; model: string }>()
  const prompts = new Map<string, number>()   // prompt id → time
  for (const [f, end] of offsets) {
    if (!end) continue
    const sub = f.includes(`${path.sep}subagents${path.sep}`)
    const rl = readline.createInterface({ input: fs.createReadStream(f, { start: 0, end: end - 1 }), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line.includes('"assistant"') && !line.includes('"user"')) continue
        let m: any
        try { m = JSON.parse(line) } catch { continue }
        const t = Date.parse(m.timestamp)
        if (!t) continue
        if (!sub && isPrompt(m)) { prompts.set(m.promptId ?? m.uuid, t); continue }
        const msg = m.message
        if (m.type !== 'assistant' || !msg?.usage || !msg.id || msg.model === '<synthetic>') continue
        const usd = costOf(msg.usage, msg.model), prev = msgs.get(msg.id)
        if (!prev || usd > prev.usd) msgs.set(msg.id, { t, usd, model: msg.model })
      }
    } catch {}
  }
  const read: Record<string, CostDay> = {}
  for (const x of msgs.values()) add(read, x.t, x.usd, x.model)
  for (const t of prompts.values()) (read[dayKey(t)] ??= blank()).prompts++
  // Each day: the larger count, with the limit peaks kept from the saved record.
  const merged = { ...first }
  for (const k in read) {
    const a = first[k]
    merged[k] = !a || read[k].usd > a.usd ? { ...read[k], ...(a ? peaks(a, read[k]) : {}) } : a
  }
  base = merged
  scanning = false
  save()
}

// Spend and prompts the meter counts from now on.
onCount((e) => {
  if (e.prompt) (live[dayKey(e.t)] ??= blank()).prompts++
  else add(live, e.t, e.usd, e.model)
  save()
})

// The highest share of each limit reported today, and whether extra usage paid for any of it.
export function limit(u: Usage) {
  const d = (live[dayKey(Date.now())] ??= blank())
  if (u.fiveHour != null) d.five = Math.max(d.five ?? 0, u.fiveHour)
  if (u.sevenDay != null) d.seven = Math.max(d.seven ?? 0, u.sevenDay)
  if (u.overage) d.overage = true
  save()
}

// Your plan, from the account Claude Code keeps in ~/.claude.json.
export function plan(): Plan | null {
  try {
    const a = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).oauthAccount ?? {}
    const tier = String(a.organizationRateLimitTier ?? '')
    if (/max_20x/.test(tier)) return PLANS.find((p) => p.tier === 'max20')!
    if (/max_5x/.test(tier)) return PLANS.find((p) => p.tier === 'max5')!
    if (a.organizationType === 'claude_pro') return PLANS.find((p) => p.tier === 'pro')!
  } catch {}
  return null
}

// Claude Code's login token: in the macOS keychain, or in ~/.claude/.credentials.json elsewhere.
function token(): Promise<string | null> {
  const pick = (s: string) => { try { const o = JSON.parse(s).claudeAiOauth; return o?.accessToken && !(o.expiresAt < Date.now()) ? o.accessToken as string : null } catch { return null } }
  if (process.platform !== 'darwin') {
    try { return Promise.resolve(pick(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))) } catch { return Promise.resolve(null) }
  }
  return new Promise((ok) => execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, out) => ok(err ? null : pick(out))))
}

let fetched = 0
async function fetchExtra() {
  if (Date.now() - fetched < 10 * 60_000) return
  fetched = Date.now()
  const tok = await token()
  if (!tok) return
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return
    const j: any = await r.json()
    const x = j.extra_usage
    if (x) {
      const unit = 10 ** (x.decimal_places ?? 2), month = dayKey(Date.now()).slice(0, 7)
      const extra: Extra = { at: Date.now(), month, enabled: !!x.is_enabled, used: (x.used_credits ?? 0) / unit, limit: x.monthly_limit != null ? x.monthly_limit / unit : null, reason: x.disabled_reason ?? null }
      saved.extra = extra
      saved.extraMonths = { ...saved.extraMonths, [month]: Math.max(saved.extraMonths?.[month] ?? 0, extra.used) }
    }
    limit({ fiveHour: j.five_hour?.utilization != null ? j.five_hour.utilization / 100 : undefined, sevenDay: j.seven_day?.utilization != null ? j.seven_day.utilization / 100 : undefined })
  } catch {}
}

export async function reply(): Promise<CostsReply> {
  await fetchExtra()
  const d = days(), keys = Object.keys(d).sort()
  return { plan: plan(), days: d, rate: rate(), extra: saved.extra ?? null, extraMonths: saved.extraMonths ?? {}, scanning, since: keys[0] ?? null }
}

export function start() {
  void scan()
  setInterval(() => void fetchExtra(), 3_600_000).unref()
}
