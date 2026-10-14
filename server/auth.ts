// Signing Claude Code in, from the browser. Sessions run on your Claude Code
// login; when it is missing or has expired, `claude auth login` runs here. It
// opens the sign-in page itself and finishes on its own; if that fails, the
// page it prints shows a code, which you paste into Codinger and we pass on.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { AuthState } from '../shared/types.ts'

// The Claude Code binary. Codinger was called Codiner until October 2026; the old name still works.
export const CLAUDE = process.env.CODINGER_CLAUDE ?? process.env.CODINER_CLAUDE ?? 'claude'
// Errors that mean the login is gone, as Claude Code words them.
export const AUTH_ERROR = /Failed to authenticate|OAuth (session|token)|not logged in|Please run \/login|Invalid API key|authentication_failed|invalid_grant/i
// A sign-in that just worked and failed again at once would loop; then wait for the button.
const LOOP_MS = 60_000

let auth: AuthState = { state: 'ok' }
let proc: ChildProcess | null = null
let lastSignIn = 0
let onChange: (a: AuthState) => void = () => {}
let onSignedIn: () => void = () => {}

export function initAuth(o: { change(a: AuthState): void; signedIn(): void }) {
  onChange = o.change
  onSignedIn = o.signedIn
  execFile(CLAUDE, ['auth', 'status'], { env: childEnv(), timeout: 20_000 }, (_err, out) => {
    let loggedIn = true
    try { loggedIn = JSON.parse(out).loggedIn !== false } catch { /* unknown: assume fine */ }
    if (!loggedIn) needed()
  })
}

export const authState = () => auth

function set(a: AuthState) { auth = a; onChange(a) }

export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Never bill per token: without these, claude uses your subscription login.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  // Don't let the child think it is nested inside another Claude Code.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

// The login is missing at start, or a turn failed for want of it: sign in.
// Nothing else starts a sign-in by itself.
export function needed() {
  if (proc) return
  if (Date.now() - lastSignIn < LOOP_MS) { set({ state: 'needed' }); return }
  startLogin()
}

export function startLogin() {
  if (proc) return
  const p = spawn(CLAUDE, ['auth', 'login'], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  proc = p
  let out = ''
  set({ state: 'pending' })
  const read = (d: Buffer) => {
    out = (out + d.toString('utf8')).slice(-8000)
    // The link comes wrapped in a terminal hyperlink escape; take the bare URL.
    const url = /https:\/\/[^\s\x07\x1b]+/.exec(out)?.[0]
    if (url && url !== auth.url && auth.state === 'pending') set({ state: 'pending', url })
  }
  p.stdout!.on('data', read)
  p.stderr!.on('data', read)
  p.stdin!.on('error', () => {})
  p.on('error', (e) => { proc = null; set({ state: 'failed', error: e.message }) })
  p.on('exit', (code) => {
    if (proc !== p) return
    proc = null
    if (code === 0) { lastSignIn = Date.now(); set({ state: 'ok' }); onSignedIn() }
    else if (auth.state === 'pending') {
      const tail = out.replace(/\x1b\][^\x07]*\x07|\x1b\[[\d;]*m/g, '').trim().split('\n').filter((l) => !/Paste code|browser|visit:/i.test(l)).slice(-3).join(' ')
      set({ state: 'failed', error: tail || `claude auth login exited with code ${code}` })
    }
  })
}

export function submitCode(code: string) {
  if (!proc) throw new Error('No sign-in is running')
  proc.stdin!.write(code.trim() + '\n')
}

export function cancelLogin() {
  const p = proc
  proc = null
  p?.kill('SIGTERM')
  set({ state: 'needed' })
}
