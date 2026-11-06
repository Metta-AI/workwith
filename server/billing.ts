// Which account a session's Claude Code bills to, when CODINGER_BILLING=fallback.
//
// Then the desk runs sessions on the Claude Code login (a plan with usage limits)
// and keeps the cloud provider the environment names (CLAUDE_CODE_USE_BEDROCK or
// _VERTEX, with its model ids) for when the plan can't: while no one has signed
// in yet, and after a limit is hit, until it resets. Each switch to the provider
// runs CODINGER_ALERT_CMD (with the reason in CODINGER_ALERT_TEXT), so whoever
// pays hears of it.
//
// Without the setting the environment decides, as before: a cloud provider bills
// per token, else the login's plan.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DATA } from './store.ts'

const env = process.env
const FILE = path.join(DATA, 'billing.json')
export const FALLBACK = (env.CODINGER_BILLING ?? env.CODINER_BILLING) === 'fallback'
const PROVIDER = !!(env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX)
// What the provider needs that the plan must not see: the switch itself and its model ids.
const PROVIDER_VARS = /^(CLAUDE_CODE_USE_(BEDROCK|VERTEX)|ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL(_NAME)?|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_VERTEX_\w+)$/

// Errors that mean the plan's limit is used up, as Claude Code words them.
export const LIMIT_ERROR = /usage limit reached|hit your (usage |weekly |session )?limit|limit reached.{0,40}reset|out of extra usage/i

export type BillingState = { on: 'plan' | 'api'; why?: 'limit' | 'login'; until?: number; since?: number }
let state: BillingState = { on: 'plan' }
try { const x = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (x.on === 'api' || x.on === 'plan') state = x } catch {}
let onChange: (s: BillingState) => void = () => {}
export const onBilling = (f: (s: BillingState) => void) => { onChange = f }

const save = () => fs.writeFile(FILE, JSON.stringify(state), () => {})
function set(s: BillingState) { state = s; save(); onChange(s) }

// A limit that has reset puts the plan back.
function current(): BillingState {
  if (state.on === 'api' && state.why === 'limit' && state.until && Date.now() >= state.until) set({ on: 'plan' })
  return state
}
export const billingState = (): BillingState => FALLBACK && PROVIDER ? current() : { on: PROVIDER ? 'api' : 'plan' }
export const onPlan = () => billingState().on === 'plan'
// Why sessions bill per token though a plan is set up: for the desk to say.
export function billingNote(): string | undefined {
  const s = billingState()
  if (!FALLBACK || s.on !== 'api') return undefined
  return s.why === 'login' ? 'On API billing: Claude Code is not signed in to the plan'
    : `On API billing: the plan's usage limit was reached${s.until ? `; back on the plan ${new Date(s.until).toLocaleString()}` : ''}`
}

// The environment without the provider: for the login, and for sessions on the plan.
export function planEnv(from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!FALLBACK) return from
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(from)) if (!PROVIDER_VARS.test(k)) out[k] = v
  return out
}
export const sessionEnv = (from: NodeJS.ProcessEnv) => onPlan() ? planEnv(from) : from

// A session's model, named the way the account it runs on knows it: the provider's ids
// (global.anthropic.claude-opus-5-5) mean nothing to the plan, and the plan's to Bedrock,
// which takes the family's alias and maps it with ANTHROPIC_DEFAULT_*_MODEL.
export function modelFor(model: string | null | undefined): string | null {
  if (!model || !FALLBACK || !PROVIDER) return model ?? null
  const provider = /(^|\.)anthropic\./.test(model)
  if (onPlan()) return provider ? model.replace(/^([a-z]+\.)?anthropic\./, '').replace(/-v\d+(:\d+)?(?=\[|$)/, '') : model
  if (provider || !/claude|opus|sonnet|haiku|fable/.test(model)) return model
  return /opus/.test(model) ? 'opus' : /sonnet/.test(model) ? 'sonnet' : /haiku/.test(model) ? 'haiku' : null
}

// The plan can't take this: bill the provider until `resetsAt` (seconds), or a day if unknown.
export function limitHit(resetsAt?: number) {
  if (!FALLBACK || !PROVIDER || current().on === 'api') return false
  const until = resetsAt ? resetsAt * 1000 : Date.now() + 86_400_000
  set({ on: 'api', why: 'limit', until, since: Date.now() })
  alert(`Plan usage limit reached: sessions now bill per token through the cloud provider until ${new Date(until).toUTCString()}.`)
  return true
}

// No login to run on: the provider meanwhile. Signing in puts the plan back.
export function noLogin() {
  if (!FALLBACK || !PROVIDER || current().on === 'api') return
  set({ on: 'api', why: 'login', since: Date.now() })
  alert('Claude Code is not signed in, so sessions bill per token through the cloud provider. Sign in from the desk to put them on the plan.')
}
export function signedIn() {
  if (FALLBACK && state.on === 'api' && state.why === 'login') set({ on: 'plan' })
}

function alert(text: string) {
  console.log(`[billing] ${text}`)
  const cmd = env.CODINGER_ALERT_CMD ?? env.CODINER_ALERT_CMD
  if (!cmd) return
  const p = spawn('/bin/sh', ['-c', cmd], { env: { ...env, CODINGER_ALERT_TEXT: text }, stdio: 'ignore', detached: true })
  p.on('error', (e) => console.error('[billing] alert failed:', e.message))
  p.unref()
}
