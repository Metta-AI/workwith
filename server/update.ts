// Updates from origin/main (shared/update.ts). Every 10 minutes, and at start, the
// server fetches origin/main. When this checkout is behind, the page asks first,
// unless the setting says always or never. On yes: when it is on main, with no commits
// of its own and no uncommitted changes, it fast-forwards as soon as no session is
// working, runs npm install when the packages changed, and restarts (the restart
// builds the page). Anything else stops it with a reason: the page offers an agent
// that does the update by hand.

import { execFile } from 'node:child_process'
import type { UpdateMode, UpdateStatus } from '../shared/update.ts'

const EVERY = 10 * 60_000
const WIN = process.platform === 'win32'

type Opts = { root: string; mode: () => UpdateMode; busy: () => boolean; restart: () => void; onChange: (u: UpdateStatus) => void }
let o: Opts | null = null
let status: UpdateStatus = { state: 'current' }
let checking = false

export const updateStatus = () => status

function set(u: UpdateStatus) {
  status = u
  o?.onChange(u)
}

function run(cmd: string, args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: o!.root, timeout, shell: WIN && cmd === 'npm', maxBuffer: 10 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ')))
      else resolve(stdout.trim())
    })
  })
}
const git = (...args: string[]) => run('git', args)
const ancestor = (a: string, b: string) => git('merge-base', '--is-ancestor', a, b).then(() => true, () => false)

export function startUpdates(opts: Opts) {
  o = opts
  if (process.env.CODINGER_NO_UPDATE) return
  setTimeout(() => void check(true), 20_000).unref()
  setInterval(() => void check(true), EVERY).unref()
  // While an update waits for sessions, look again often (no fetch).
  setInterval(() => { if (status.state === 'waiting') void check(false) }, 30_000).unref()
}

async function check(fetch: boolean) {
  if (!o || checking || status.state === 'updating') return
  const mode = o.mode()
  if (mode === 'never') return set({ state: 'current' })
  checking = true
  try {
    if (fetch) await git('fetch', '-q', 'origin', 'main')
    const [head, remote] = await Promise.all([git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main')])
    if (head === remote || await ancestor(remote, head)) return set({ state: 'current' })
    const info = {
      behind: Number(await git('rev-list', '--count', 'HEAD..origin/main')),
      head: remote.slice(0, 7),
      subject: await git('log', '-1', '--format=%s', 'origin/main'),
    }
    if (mode === 'ask') return set({ state: 'offer', ...info })
    const why = await blocker()
    if (why) return set({ state: 'blocked', ...info, why })
    if (o.busy()) return set({ state: 'waiting', ...info })
    await apply(info)
  } catch {
    // No network, or not a git checkout: say nothing, try again later.
  } finally { checking = false }
}

// What keeps a fast-forward from being safe here, if anything.
async function blocker(): Promise<string | null> {
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') return `This checkout is on the branch ${branch}, not main.`
  if (!await ancestor('HEAD', 'origin/main')) return 'This checkout has commits that are not on origin/main.'
  if (await git('status', '--porcelain', '--untracked-files=no')) return 'This checkout has uncommitted changes.'
  return null
}

async function apply(info: { behind: number; head: string; subject: string }) {
  set({ state: 'updating', ...info })
  try {
    const old = await git('rev-parse', 'HEAD')
    await git('merge', '--ff-only', '-q', 'origin/main')
    const changed = (await git('diff', '--name-only', old, 'HEAD')).split('\n')
    if (changed.includes('package.json') || changed.includes('package-lock.json')) await run('npm', ['install', '--no-audit', '--no-fund'], 600_000)
    o!.restart()
  } catch (e) {
    set({ state: 'failed', ...info, why: e instanceof Error ? e.message : String(e) })
  }
}

// The setting changed: ask, install or forget the update that is there.
export function updateModeChanged() { if (status.state !== 'updating') void check(false) }

// "Update" or "Update now" on the page: the same checks, without the wait for sessions
// (a restart keeps working sessions running).
export async function updateNow(): Promise<UpdateStatus> {
  if (status.state === 'current' || status.state === 'updating') return status
  const why = await blocker()
  if (why) set({ ...status, state: 'blocked', why })
  else void apply(status)
  return status
}

// The first message of the agent that updates by hand.
export function updatePrompt(): string {
  const why = 'why' in status ? ` The automatic update stopped: ${status.why}` : ''
  return `Codinger's own checkout (${o?.root}) is behind origin/main.${why}\n\n` +
    'Bring it up to date with origin/main without losing local work: look at what is uncommitted or unpushed and who it belongs to (`~/.claude/bin/agents active` if it exists), ' +
    'and ask me before you discard, stash or rewrite anything. Run `npm install` if package.json or package-lock.json changed. ' +
    'Then restart Codinger with its own restart (POST /api/restart on this server).'
}
