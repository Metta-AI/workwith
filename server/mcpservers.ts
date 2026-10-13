// Your MCP servers (claude.ai connectors, user and project servers), for sessions
// that start with them off. A new worker starts with --strict-mcp-config, so it
// has only Codiner's own server; you, or Claude through use_mcp_server, turn
// others on, and Codiner adds them to the running process (Session.setMcp, the
// mcp_set_servers control request). Turning one on keeps the prompt cache: its
// tools reach Claude as a message added to the end, not as a changed prompt.
//
// The list and each server's config come from a probe: a `claude -p` that starts
// without the strict flag, answers mcp_status and ends, with no API call. It runs
// only when you press Refresh in the MCP dialog: servers seldom change, and a
// session that needs one Codiner doesn't know asks you to (SessionMeta.mcp.missing).
// Kept per folder, since project servers differ, in mcp-servers.json.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA } from './store.ts'
import { childEnv } from './auth.ts'

export type McpServer = { name: string; status: string; scope: string; tools: number; config: Record<string, unknown> }

const FILE = path.join(DATA, 'mcp-servers.json')
let known: Record<string, { at: number; servers: McpServer[] }> = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } })()
const probing = new Map<string, Promise<McpServer[]>>()

const save = () => fs.writeFile(FILE, JSON.stringify(known), () => {})

// The servers a session in `cwd` can turn on. Before a probe of that folder, the
// claude.ai connectors seen anywhere (they are the same in every folder).
export function serversFor(cwd: string): McpServer[] {
  if (known[cwd]) return known[cwd].servers
  const seen = new Map<string, McpServer>()
  for (const k of Object.values(known)) for (const s of k.servers) if (s.scope === 'claudeai') seen.set(s.name, s)
  return [...seen.values()]
}

// Look for the servers of `cwd` again (one probe at a time per folder).
export function probe(cwd: string): Promise<McpServer[]> {
  const running = probing.get(cwd)
  if (running) return running
  const p = run(cwd).then((servers) => {
    known[cwd] = { at: Date.now(), servers }
    save()
    return servers
  }).finally(() => probing.delete(cwd))
  probing.set(cwd, p)
  return p
}

// Servers connect a few seconds after the process starts: ask until the answer
// stops changing and nothing is still pending, for at most 20 seconds.
function run(cwd: string): Promise<McpServer[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.CODINER_CLAUDE ?? 'claude',
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
      { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = '', n = 0, last = '', same = 0, done = false
    const ask = () => p.stdin.write(JSON.stringify({ type: 'control_request', request_id: `s${n++}`, request: { subtype: 'mcp_status' } }) + '\n')
    const finish = (servers: McpServer[] | null, err?: string) => {
      if (done) return
      done = true
      clearInterval(timer); clearTimeout(stop)
      p.kill()
      if (servers) resolve(servers); else reject(new Error(err ?? 'No answer from Claude Code'))
    }
    const timer = setInterval(ask, 1500)
    const stop = setTimeout(() => finish(null, 'Claude Code did not list its MCP servers in time'), 20_000)
    p.on('error', (e) => finish(null, e.message))
    p.stdin.on('error', () => {})
    p.stdout.setEncoding('utf8').on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let m: any
        try { m = JSON.parse(line) } catch { continue }
        const list = m.type === 'control_response' ? m.response?.response?.mcpServers : null
        if (!Array.isArray(list)) continue
        const servers: McpServer[] = list.filter((x: any) => x?.name && x.name !== 'codiner').map((x: any) => ({
          name: x.name, status: String(x.status ?? ''), scope: String(x.scope ?? ''), tools: Array.isArray(x.tools) ? x.tools.length : 0, config: x.config ?? {},
        }))
        const key = JSON.stringify(servers.map((s) => [s.name, s.status]))
        same = key === last ? same + 1 : 0
        last = key
        // No servers at all: wait a little longer before believing it.
        if (same >= (servers.length ? 2 : 5) && !servers.some((s) => s.status === 'pending')) finish(servers)
      }
    })
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }) + '\n')
  })
}

// The configs to hand a process for the servers it should have on.
export function configsFor(cwd: string, names: string[]): Record<string, unknown> {
  const all = serversFor(cwd)
  return Object.fromEntries(names.flatMap((n) => { const s = all.find((x) => x.name === n); return s ? [[n, s.config]] : [] }))
}
