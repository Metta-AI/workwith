// npm test. CODINGER_BASE (server/base.ts): the helpers, then a real server under /desk/ada.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { pageUnder, parseBase, underBase } from './base.ts'

test('parseBase takes a path with or without its trailing slash, and nothing else', () => {
  assert.equal(parseBase(undefined), '')
  assert.equal(parseBase(''), '')
  assert.equal(parseBase('/desk/ada'), '/desk/ada')
  assert.equal(parseBase('/desk/ada/'), '/desk/ada')
  assert.throws(() => parseBase('desk/ada'))
  assert.throws(() => parseBase('/desk/a da'))
  assert.throws(() => parseBase('https://x/desk'))
})

test('underBase takes the base off, and leaves other paths as they are', () => {
  assert.equal(underBase('', '/api/sessions'), '/api/sessions')
  assert.equal(underBase('/desk/ada', '/desk/ada/api/sessions?x=1'), '/api/sessions?x=1')
  assert.equal(underBase('/desk/ada', '/desk/ada/'), '/')
  assert.equal(underBase('/desk/ada', '/desk/ada'), '/')
  assert.equal(underBase('/desk/ada', '/desk/ada?push=1'), '/?push=1')
  assert.equal(underBase('/desk/ada', '/mcp/token'), '/mcp/token')
  assert.equal(underBase('/desk/ada', '/desk/adam/api'), '/desk/adam/api')
})

const PAGE = '<html><head><link rel="stylesheet" href="/agent/theme.css" /><link rel="manifest" href="/manifest.webmanifest" /><script src="/assets/main-1.js"></script></head></html>'

test('pageUnder: at the root the page is as built', () => {
  assert.equal(pageUnder(PAGE, '', false), PAGE)
  assert.equal(pageUnder(PAGE, '', true), PAGE)
})

test('pageUnder: through the hub (/m/<name>) only the assets and window.__base move, as before', () => {
  const was = PAGE.replaceAll('"/assets/', '"/m/box/assets/').replace('<head>', '<head><script>window.__base="/m/box/"</script>')
  assert.equal(pageUnder(PAGE, '/m/box', false), was)
})

test('pageUnder: under CODINGER_BASE the links go under it and the page knows its server', () => {
  const html = pageUnder(PAGE, '/desk/ada', true)
  assert.match(html, /window\.__base="\/desk\/ada\/";window\.__root="\/desk\/ada"/)
  assert.match(html, /href="\/desk\/ada\/agent\/theme\.css"/)
  assert.match(html, /href="\/desk\/ada\/manifest\.webmanifest"/)
  assert.match(html, /src="\/desk\/ada\/assets\/main-1\.js"/)
  assert.doesNotMatch(html, /"\/(agent|assets|manifest)/)
})

test('a server under /desk/ada answers there, behind a proxy named in CODINGER_HOSTS', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codinger-base-'))
  const port = 4900 + Math.floor(Math.random() * 90)
  const server = spawn(process.execPath, [path.join(import.meta.dirname, 'index.ts')], {
    env: { ...process.env, HOME: home, PORT: String(port), CODINGER_BASE: '/desk/ada', CODINGER_AGENT_NAME: 'Ada', CODINGER_HOSTS: 'proxy.test', CODINGER_USER_HEADER: 'x-user' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { server.kill(); fs.rmSync(home, { recursive: true, force: true }) })
  await new Promise<void>((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('Codinger on')) resolve() })
    server.on('exit', (code) => reject(new Error(`the server stopped (${code})`)))
  })
  // fetch() would name 127.0.0.1 as the host, which Codinger knows anyway: the proxy's name is the point.
  const get = (p: string, host = 'proxy.test') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    }).on('error', reject)
  })

  const bare = await get('/desk/ada')
  assert.equal(bare.status, 308)
  assert.equal(bare.headers.location, '/desk/ada/')

  const manifest = JSON.parse((await get('/desk/ada/manifest.webmanifest')).body)
  assert.equal(manifest.start_url, '/desk/ada/')
  assert.equal(manifest.scope, '/desk/ada/')

  assert.deepEqual(JSON.parse((await get('/desk/ada/_remote/whoami')).body), { web: false })
  assert.equal((await get('/desk/ada/sw.js')).status, 200)
  assert.equal((await get('/desk/ada/agent/theme.css')).headers['content-type'], 'text/css')
  assert.equal((await get('/desk/ada/api/sessions', 'evil.test')).status, 403)

  const hello = await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/desk/ada/ws`, { headers: { host: 'proxy.test', origin: 'https://proxy.test', 'x-user': 'grace@example.com' } })
    ws.on('message', (m) => { const msg = JSON.parse(String(m)); if (msg.type === 'hello') { ws.close(); resolve(msg) } })
    ws.on('error', reject)
  })
  assert.equal(hello.agent.name, 'Ada')
  assert.equal(hello.me.login, 'grace@example.com')
})
