// Rolling notes and keep-warm. While a session waits for you, Codinger makes a few
// one-off calls on its conversation (Session.forkCommand: forked and not saved,
// so the conversation stays as it is). Each call reads the prompt cache, which
// keeps it warm for another TTL. The first call in a spell of quiet also brings
// the notes in .codinger/notes/<id>.md up to date, to start a new session from.
// The worker keeps those notes itself as it works (server/prompts.ts); this call
// fills the gaps with edits, so it neither undoes the worker's nor yours, and when
// the worker kept up it costs little more than a keep-alive call.
//
// A call after the cache has expired writes the whole context to it again: worse
// than no call at all. So a call goes out only well inside the TTL, judged by the
// wall clock on every tick (timers stop while the Mac sleeps); nothing is queued
// or retried; and each call's usage is checked: one that wrote the context again
// turns automatic calls off for that session.
//
// Costs are in dollars at the model's API prices (shared/prices.ts), like the
// meter's (server/meter.ts), so its estimate of the 5-hour limit applies. Every
// call goes to notes.jsonl.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SessionMeta, Settings, Usage } from '../shared/types.ts'
import { DEFAULT_CACHE_GUARD } from '../shared/cache.ts'
import { KEEP_WARM, notesFile } from '../shared/notes.ts'
import { spend } from './meter.ts'
import { offTranscript } from './usage.ts'
import { addSpend, coldCost, costOf, priceOf, warmCost } from '../shared/prices.ts'
import { DATA } from './store.ts'
import { NOTES_SECTIONS } from './prompts.ts'
import type { Session } from './session.ts'

const HOUR = 3_600_000
const TICK = 30_000
const NOTES_IDLE = 20 * 60_000   // quiet this long: bring the notes up to date
const PING_AT = 45 * 60_000      // a call this long after the cache's clock started,
const SEND_BY = 10 * 60_000      // and never later than this before it expires
const NOTES_MIN = 20_000         // less context than this is not worth notes
const TIMEOUT = 5 * 60_000
const LOG = path.join(DATA, 'notes.jsonl')

const PING = `[Codinger, automatic] A keep-alive call from Codinger, not a message from the user. Your reply is not added to the conversation. Do not use any tools. Reply with the single word: ok`

const REQUEST = `[Codinger, automatic] A request from Codinger, not a message from the user. Your reply is not added to the conversation. Do not use any tools.`
const KEEP = `Keep exact names: files, identifiers, commands, numbers. Leave out what the repository already records, such as the code itself and git history. Keep them compact: at most about 3,000 words, and most sessions need far fewer.`

// No notes yet: all of them. Notes already: only edits, since you or the worker may have written them.
const notesPrompt = (file: string, prev: string | null) => prev == null ? `${REQUEST}

Write notes on this conversation that let a new session continue the work from the notes alone. Use Markdown with these sections, and leave out a section with nothing in it:

${NOTES_SECTIONS}

${KEEP} Reply with the notes only, starting at the first section heading.` : `${REQUEST}

The notes on this conversation in \`${file}\` are below, as they are now. You may have written some of them as you worked, and the user may have edited them. Bring them up to date with the conversation, so that a new session can continue the work from the notes alone: add what is missing, change what changed, and remove what no longer matters. Keep the user's edits.

Reply with edits only, in this form, as many as you need:

<edit>
<old>exact text from the notes</old>
<new>the text to put in its place</new>
</edit>

Each <old> must appear in the notes exactly once. To add text, take as <old> the line that it goes after, and repeat that line at the start of <new>. To remove text, leave <new> empty. A section that is not there yet goes after the section before it in this order:

${NOTES_SECTIONS}

${KEEP} If the notes are already up to date, reply with the single word: none

<notes>
${prev}
</notes>`

type Ctx = { sessions: () => Iterable<Session>; settings: () => Settings; usage: () => Usage; changed: () => void }
let ctx: Ctx
const busy = new Set<string>()
let lastTick = 0

const k = (n: number) => `${Math.round(n / 1000)}k`
const log = (x: object) => fs.appendFile(LOG, JSON.stringify({ t: Date.now(), ...x }) + '\n', () => {})

// ---- the notes file --------------------------------------------------------

export const notesPath = (m: SessionMeta) => path.join(m.cwd, notesFile(m.id))
// Codinger was called Codiner until October 2026: notes from then are in .codiner/notes/.
const oldNotesPath = (m: SessionMeta) => path.join(m.cwd, '.codiner', 'notes', `${m.id}.md`)
const HEAD = /^# .*\n\n<!-- coding?er notes .*-->\n\n/

// The notes' folder, kept out of git: the worker may write the file before Codinger does.
export function notesDir(m: SessionMeta): string {
  const dir = path.dirname(notesPath(m))
  try {
    fs.mkdirSync(dir, { recursive: true })
    // Notes are yours, not the repository's: keep them out of git unless you say otherwise.
    const ignore = path.join(dir, '.gitignore')
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
    if (!fs.existsSync(notesPath(m)) && fs.existsSync(oldNotesPath(m))) fs.renameSync(oldNotesPath(m), notesPath(m))
  } catch { /* a directory we cannot write to: no notes there */ }
  return dir
}

export function readNotes(m: SessionMeta): string | null {
  for (const file of [notesPath(m), oldNotesPath(m)]) {
    try { return fs.readFileSync(file, 'utf8').replace(HEAD, '').trim() || null } catch { /* not there */ }
  }
  return null
}

function saveNotes(m: SessionMeta, body: string) {
  const file = notesPath(m)
  notesDir(m)
  const head = `# ${m.title}\n\n<!-- codinger notes · session ${m.id} · ${new Date().toISOString()} · from ${k(m.context.used)} tokens of context -->\n\n`
  fs.writeFileSync(file, head + body.trim() + '\n')
}

// Apply the call's edits to the notes as they are now: the worker or you may have
// changed them while it ran. An edit whose old text is not there exactly once is skipped.
const EDIT = /<edit>\s*<old>\n?([\s\S]*?)\n?<\/old>\s*<new>\n?([\s\S]*?)\n?<\/new>\s*<\/edit>/g
function applyEdits(notes: string, reply: string): { text: string; applied: number; skipped: number } {
  let text = notes, applied = 0, skipped = 0
  for (const [, old, rep] of reply.matchAll(EDIT)) {
    const at = old ? text.indexOf(old) : -1
    if (at < 0 || text.indexOf(old, at + 1) >= 0) { skipped++; continue }
    // Removed text takes its line break with it.
    const end = at + old.length + (!rep && text[at + old.length] === '\n' ? 1 : 0)
    text = text.slice(0, at) + rep + text.slice(end)
    applied++
  }
  return { text: text.replace(/\n{3,}/g, '\n\n'), applied, skipped }
}

// ---- costs -----------------------------------------------------------------

// In dollars. Keep-warm runs only on the 1-hour cache, so a cold send writes at 2× input.
function cost(m: SessionMeta, kind: 'notes' | 'ping' | 'cold') {
  const c = m.context.used, p = priceOf(m.model, c)
  if (kind === 'cold') return coldCost(c, m.model, HOUR)
  // A ping adds about 1.5k tokens to the cache and says "ok"; notes add the notes
  // and the request, then write edits (about 2k tokens, thinking included), or all
  // of the notes the first time.
  const size = m.notes?.size ?? 0
  const [added, out] = kind === 'ping' ? [1_500, 100] : [2_500 + size, size ? 2_000 : 6_000]
  return warmCost(c, m.model) + (2 * p.input * added + p.output * out) / 1e6
}

function usageStop(m: SessionMeta, kind: 'notes' | 'ping'): string | null {
  const limit = (ctx.settings().keepWarmUsage ?? KEEP_WARM.usage) / 100
  const u = ctx.usage()
  if (limit >= 1 || u.fiveHour == null) return null
  const r = u.rate?.fiveHour
  const after = u.fiveHour + (r != null ? cost(m, kind) * r : 0)
  return after >= limit ? `Your 5-hour usage is near ${Math.round(limit * 100)}%` : null
}

function keepWarmStop(m: SessionMeta, idle: number): string | null {
  const st = ctx.settings()
  const hours = st.keepWarmHours ?? KEEP_WARM.hours
  const min = st.cacheGuard || DEFAULT_CACHE_GUARD
  if (!hours) return 'Keep-warm is off in Settings'
  if (idle >= hours * HOUR) return `No activity for ${hours} hours`
  if (m.context.used < min) return `The context is under ${k(min)} tokens, so it is cheap to cache again`
  if ((m.notes?.spent ?? 0) + cost(m, 'ping') > cost(m, 'cold')) return 'The calls so far cost as much as one cold resume'
  return usageStop(m, 'ping')
}

// ---- the schedule ----------------------------------------------------------

export function startNotes(c: Ctx) {
  ctx = c
  // Calls in flight when the server stopped are gone.
  for (const s of c.sessions()) if (s.meta.notes?.running) delete s.meta.notes.running
  lastTick = Date.now()
  setInterval(tick, TICK).unref()
}

function tick() {
  const now = Date.now()
  // Far longer than a tick since the last one: the Mac slept, or the server stalled.
  // Skip this one; the next judges by the wall clock alone.
  const gap = now - lastTick
  lastTick = now
  if (gap > 3 * TICK) return
  for (const s of ctx.sessions()) {
    try { consider(s, now) } catch (e) { console.error(`[notes ${s.meta.id}]`, e) }
  }
}

function stop(m: SessionMeta, reason: string, at: number) {
  m.notes!.end = { reason, at }
  ctx.changed()
}

function consider(s: Session, now: number) {
  const m = s.meta
  if (m.kind !== 'worker' || m.archived || !m.started || m.resumeAt || !m.cache || busy.has(m.id)) return
  if (m.status === 'working' || m.status === 'permission' || m.compacting) return
  const n = (m.notes ??= {})
  // Anything new in the session starts a new spell of quiet.
  if (n.quiet !== m.lastActivity) { Object.assign(n, { quiet: m.lastActivity, spent: 0, calls: 0, end: undefined }); ctx.changed() }
  if (n.end || n.off) return
  const { at, ttl } = m.cache
  const expires = at + ttl
  // Only the 1-hour cache leaves room for safe margins; a 5-minute one just expires.
  if (ttl < HOUR) return
  if (now > expires - SEND_BY) return stop(m, 'The cache expired', expires)
  const idle = now - m.lastActivity
  const notes = ctx.settings().notes !== false && (n.upTo ?? 0) < m.lastActivity && idle >= NOTES_IDLE && m.context.used >= NOTES_MIN
  if (!notes && now - at < PING_AT) return
  const why = notes ? usageStop(m, 'notes') : keepWarmStop(m, idle)
  if (why) return stop(m, why, expires)
  void call(s, notes ? 'notes' : 'ping')
}

// Notes now, from the Notes dialog. Refused when the cache is cold or about to be,
// unless you said to go ahead.
export function notesNow(s: Session, force = false): string | null {
  const m = s.meta
  if (!m.started) return 'This session has no conversation yet'
  if (busy.has(m.id)) return 'A call is already running'
  if (m.status === 'working' || m.status === 'permission') return 'Wait for the turn to end'
  const left = m.cache ? m.cache.at + m.cache.ttl - Date.now() : -1
  if (left < 2 * 60_000 && !force) return 'cold'
  m.notes ??= {}
  void call(s, 'notes')
  return null
}

// Turn automatic calls on again after a cold call turned them off.
export function resumeKeepWarm(m: SessionMeta) {
  if (!m.notes) return
  delete m.notes.off
  delete m.notes.end
  ctx.changed()
}

async function call(s: Session, kind: 'notes' | 'ping') {
  const m = s.meta, n = m.notes!
  busy.add(m.id)
  n.running = kind
  ctx.changed()
  const started = Date.now(), upTo = m.lastActivity, used = m.context.used
  const prev = kind === 'notes' ? readNotes(m) : null
  let edits: { applied: number; skipped: number } | undefined
  const { cmd, args, cwd, env } = s.forkCommand()
  let out = '', err = ''
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => p.kill('SIGTERM'), TIMEOUT)
    p.stdout.setEncoding('utf8').on('data', (d: string) => { out += d })
    p.stderr.setEncoding('utf8').on('data', (d: string) => { err = (err + d).slice(-1000) })
    p.stdin.on('error', () => {})
    p.stdin.end(kind === 'notes' ? notesPrompt(notesFile(m.id), prev) : PING)
    p.on('error', (e) => { err = e.message; clearTimeout(timer); resolve(-1) })
    p.on('exit', (c) => { clearTimeout(timer); resolve(c) })
  })
  busy.delete(m.id)
  delete n.running
  let r: any = null
  try { r = JSON.parse(out) } catch { /* reported below */ }
  const u = r?.usage
  const wrote = u?.cache_creation_input_tokens ?? 0
  if (u) {
    const model = Object.keys(r.modelUsage ?? {})[0] ?? m.model ?? 'unknown'
    n.spent = (n.spent ?? 0) + costOf(u, model)
    addSpend(m, costOf(u, model), true)
    spend(u, model)
    offTranscript(m.claudeSessionId, m.cwd, u, model)
    n.calls = (n.calls ?? 0) + 1
    // The call read the cache (or wrote it): its clock starts again at this call.
    if (m.cache) m.cache.at = Math.max(m.cache.at, started)
    if (wrote > Math.max(20_000, 0.2 * used)) n.off = `A call found the cache cold and wrote ${k(wrote)} tokens to it again, so automatic calls are off for this session`
  }
  const failed = !u || r.is_error || code !== 0
  if (failed) {
    const why = String(r?.result || r?.subtype || err.trim().split('\n').pop() || `exit code ${code}`).slice(0, 200)
    n.end = { reason: `The ${kind === 'notes' ? 'notes' : 'keep-warm'} call failed: ${why}`, at: m.cache ? m.cache.at + m.cache.ttl : started }
  } else if (kind === 'notes') {
    const reply = String(r.result ?? '').trim()
    const done = (text: string) => { n.at = Date.now(); n.upTo = upTo; n.size = Math.round(text.length / 4) }
    if (prev == null) { if (reply.length > 100) { saveNotes(m, reply); done(reply) } }
    else {
      const e = applyEdits(readNotes(m) ?? prev, reply)
      edits = { applied: e.applied, skipped: e.skipped }
      if (e.applied) saveNotes(m, e.text)
      // "none" or edits: either way the notes now cover the conversation.
      if (e.applied || /^none\.?$/i.test(reply)) done(e.text)
    }
  }
  log({ id: m.id, kind, ms: Date.now() - started, context: used, read: u?.cache_read_input_tokens, wrote, out: u?.output_tokens, usd: u ? Math.round(costOf(u, m.model) * 1e4) / 1e4 : null, failed, ...(edits ?? {}), ...(n.off ? { off: true } : {}) })
  ctx.changed()
}
