// Artifacts: small HTML pages over data that agents make, each in its own folder
// under ~/.codinger/artifacts/<name>/, in the shape of a page on Prolifica:
//
//   index.html      the page; it reads its data with `await prolifica.data('slot')`
//   artifact.json   { title, description, slots: {slot: {kind, description}}, bindings: {slot: "data/x.csv"}, parent? }
//   instructions.md for agents: how to use and rebind this page (optional; published with it)
//   data/           the files the bindings name, and the source data they were made from
//                   (sources in artifact.json); subfolders are fine
//
// A second HTTP server, on a port of its own, runs them: never Codinger's origin,
// so an artifact's script cannot reach Codinger's API. It injects the bridge
// Prolifica's pages run with (fetched from Prolifica, kept up to date), so a page
// that works here works there unchanged.
//
// Codinger's own record of each (which session's tool calls wrote it, where it was
// published) is in ~/.codinger/artifacts.json, apart from the files agents write.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DATA } from './store.ts'
import { ORIGIN, call } from './prolifica.ts'
import type { Artifact, ArtifactPublished, ArtifactTouch, Visibility } from '../shared/artifacts.ts'

export const ARTIFACTS = path.join(DATA, 'artifacts')
const RECORD = path.join(DATA, 'artifacts.json')
const BLOBS = path.join(DATA, 'artifact-versions')
const BRIDGE = path.join(DATA, 'bridge.js')
fs.mkdirSync(ARTIFACTS, { recursive: true })
fs.mkdirSync(BLOBS, { recursive: true })

// versions: what its files were (path -> sha256 of a blob in artifact-versions/) at each change.
type Version = { n: number; at: number; files: Record<string, string> }
type Rec = { created?: ArtifactTouch; edits: ArtifactTouch[]; published?: ArtifactPublished; versions?: Version[] }
let record: Record<string, Rec> = (() => { try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')) } catch { return {} } })()
// Publishes from before the history was kept: the version that went up is the last one kept before it.
for (const r of Object.values(record)) {
  const p = r.published
  if (!p || p.history) continue
  p.local ??= r.versions?.filter((v) => v.at <= p.at).at(-1)?.n
  if (p.local != null) p.history = [{ version: p.version, local: p.local, at: p.at }]
}
const saveRecord = () => fs.writeFile(RECORD, JSON.stringify(record, null, 1), () => {})
const recOf = (name: string) => (record[name] ??= { edits: [] })

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i
const dirOf = (name: string) => path.join(ARTIFACTS, name)

type Manifest = {
  title?: string; description?: string; short_title?: string; view_name?: string
  /** the Prolifica isle this page came from */
  parent?: string
  slots?: Record<string, { kind?: string; description?: string }>
  bindings?: Record<string, string>
  /** the data the bound files were made from (a scraper's export, a download), by file, with
   *  where it came from. It goes up with the page, and the bound data says it was derived from it
   *  (only the slots named, if slots is given), so Prolifica makes it public when the page is. */
  sources?: Record<string, SourceMeta>
}
type SourceMeta = { url?: string; method?: string; collected_at?: string | number; notes?: string; description?: string; slots?: string[] }
function manifest(name: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(dirOf(name), 'artifact.json'), 'utf8'))
}

// An artifact's files, as they are now or as one version had them. rel: a path inside its folder.
type Source = { name: string; v?: number; read(rel: string): Buffer | null; hash(rel: string): string | undefined; manifest(): Manifest }
function sourceOf(name: string, v?: number): Source | null {
  if (!NAME_RE.test(name) || !fs.existsSync(dirOf(name))) return null
  const dir = dirOf(name)
  if (v == null) return {
    name,
    read: (rel) => { const f = path.resolve(dir, rel); return f.startsWith(dir + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null },
    hash: (rel) => { const f = path.join(dir, rel); return fs.existsSync(f) ? String(Math.round(fs.statSync(f).mtimeMs)) : undefined },
    manifest: () => manifest(name),
  }
  const ver = record[name]?.versions?.find((x) => x.n === v)
  if (!ver) return null
  const read = (rel: string) => { const h = ver.files[path.posix.normalize(rel.split(path.sep).join('/'))]; return h ? fs.readFileSync(path.join(BLOBS, h)) : null }
  return { name, v, read, hash: (rel) => ver.files[rel]?.slice(0, 16), manifest: () => JSON.parse(read('artifact.json')?.toString('utf8') ?? '{}') }
}

// Its files, in the folder and all its subfolders (data/media/...), dot files left out.
// Links are not followed, so a link to a folder above can't loop.
function walk(dir: string, each: (rel: string, abs: string) => void, rel = '') {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walk(dir, each, r)
    else if (e.isFile()) each(r, path.join(dir, r))
  }
}
function filesOf(dir: string): string[] {
  const out: string[] = []
  walk(dir, (rel) => out.push(rel))
  return out.sort()
}

// Keep what the artifact's files are now as a version, unless the last one is the same. Its number.
function snapshot(name: string): number {
  const dir = dirOf(name)
  const files: Record<string, string> = {}
  for (const rel of filesOf(dir)) {
    const bytes = fs.readFileSync(path.join(dir, rel))
    const h = sha(bytes)
    if (!fs.existsSync(path.join(BLOBS, h))) fs.writeFileSync(path.join(BLOBS, h), bytes)
    files[rel] = h
  }
  const r = recOf(name)
  const last = r.versions?.at(-1)
  if (last && JSON.stringify(last.files) === JSON.stringify(files)) return last.n
  const n = (last?.n ?? 0) + 1
  r.versions = [...(r.versions ?? []), { n, at: Date.now(), files }]
  return n
}

// The latest change to any file in the folder or its subfolders.
function mtimeOf(dir: string): number {
  let t = 0
  walk(dir, (_, abs) => { t = Math.max(t, fs.statSync(abs).mtimeMs) })
  return Math.round(t)
}

export function listArtifacts(): Artifact[] {
  const out: Artifact[] = []
  for (const e of fs.readdirSync(ARTIFACTS, { withFileTypes: true })) {
    if (!e.isDirectory() || !NAME_RE.test(e.name) || !fs.existsSync(path.join(dirOf(e.name), 'index.html'))) continue
    const r = record[e.name] ?? { edits: [] }
    const a: Artifact = { name: e.name, title: e.name, mtime: mtimeOf(dirOf(e.name)), created: r.created, edits: r.edits, published: r.published, latest: r.versions?.at(-1)?.n, versions: r.versions?.map(({ n, at }) => ({ n, at })) }
    try { const m = manifest(e.name); a.title = m.title || e.name; a.description = m.description } catch (err) { a.error = `artifact.json: ${(err as Error).message}` }
    out.push(a)
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// The artifact a file belongs to, if it is inside one's folder.
function artifactOfPath(file: unknown): string | null {
  if (typeof file !== 'string') return null
  const rel = path.relative(ARTIFACTS, path.resolve(file))
  const name = rel.split(path.sep)[0]
  return !rel.startsWith('..') && !path.isAbsolute(rel) && rel.includes(path.sep) && NAME_RE.test(name) ? name : null
}

function touch(name: string, t: ArtifactTouch) {
  const r = recOf(name)
  t = { ...t, v: snapshot(name) }
  if (r.edits.some((e) => t.tool ? e.tool === t.tool : e.sid === t.sid && e.seq === t.seq)) return saveRecord()
  r.created ??= t
  r.edits = [...r.edits, t].slice(-100)
  saveRecord()
}

// A tool call finished: if it wrote into an artifact's folder, note which session and message did,
// and keep the files as a version.
export function noteTool(tool: string, input: any, t: ArtifactTouch): boolean {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return false
  const name = artifactOfPath(input?.file_path ?? input?.notebook_path)
  if (!name) return false
  touch(name, t)
  return true
}

// ---- the show_artifact tool -------------------------------------------------------

export const artifactsPrompt = () => `

## Artifacts
When the user wants to see something (a chart, a table to explore, a dashboard, a report over data, a small tool), and whenever you analyse data, make an artifact: a page that Codinger shows in a pane next to this session. Each artifact is a folder in \`${ARTIFACTS}/<name>/\`, with a short lowercase name with hyphens:
- \`index.html\`: one self-contained page. Use \`<script type="module">\` (top-level await works) and libraries from a CDN (https://esm.sh/..., https://cdn.jsdelivr.net/npm/...). There is no build step.
- \`data/\`: the data, as files (csv, json, md, txt, images). Do not put data in the page. Subfolders are fine (\`data/media/a.jpg\`).
- \`artifact.json\`: \`{"title": "...", "description": "Two to four short sentences on what it shows.", "slots": {"rows": {"kind": "csv", "description": "One row per ...: the columns the page uses"}}, "bindings": {"rows": "data/rows.csv"}}\`. When the page came from an isle on Prolifica, add \`"parent": "<isle id>"\`.
- Source data: copy the data you started from (a scraper's export, a download, a file the user gave you) into \`data/\` as it is, even when no slot uses it, and list it in artifact.json: \`"sources": {"data/source.json": {"url": "...", "method": "...", "collected_at": "...", "notes": "..."}}\` (where it came from; each field optional). It is published with the page, and the bound data says it was made from it, so it goes public when the page does. When a source made only some of the slots' data, add \`"slots": ["..."]\` to it.
- \`instructions.md\`: instructions for agents about this page, so the next agent does not have to learn it from the HTML. Write them for each artifact. Say which data fields drive the wording, what text is fixed in the page, the limits, and what breaks. Write about the page, not about this data. Update them when you learn something about the page. They are published with the page.

The page reads its data by slot name: \`const rows = await prolifica.data('rows')\` (csv: an array of objects, numbers parsed; json: the parsed value; text and markdown: a string; image: a URL). \`prolifica.dataUrl('rows')\` gives the raw URL. The user can publish an artifact to Prolifica (prolifica.app), where other people run the same page over their own data. So keep what is particular to this data (names, units, dates) in the data, not in the page.
- Make the page work at any width and in light and dark (prefers-color-scheme). Size charts from their container, and draw them again on resize.
- Put \`data-pid="a-stable-name"\` on each chart, card and control.
- After you make or change an artifact, call show_artifact with its name. It shows the page to the user and returns the script errors of the load. Fix them until it loads clean.
- To change an artifact, edit it in place, even one another session made: Codinger records which session changed what.
- show_artifact also takes \`url\`, to show a page that a dev server on this machine serves.
`

// What each artifact's page reported from its last load in a browser: script errors,
// failed loads, console.error. A load starts a new list.
const reports = new Map<string, { at: number; lines: string[]; loaded: boolean }>()

export function checkArtifact(name: string): string | null {
  if (!NAME_RE.test(name) || !fs.existsSync(path.join(dirOf(name), 'index.html'))) return `There is no artifact "${name}": make ${path.join(dirOf(name), 'index.html')} first.`
  try {
    const m = manifest(name)
    const missing = Object.entries(m.bindings ?? {}).filter(([, f]) => !f.startsWith('prolifica:') && !fs.existsSync(path.join(dirOf(name), f)))
    if (missing.length) return `artifact.json binds ${missing.map(([s, f]) => `${s} to ${f}`).join(', ')}, but there is no such file.`
  } catch (e) { return `artifact.json could not be read: ${(e as Error).message}` }
  return null
}

export function showArtifact(name: string, t: ArtifactTouch) {
  touch(name, t)
  reports.delete(name)
}

// After the pane reloads the page: what it reported, or why there is nothing. It waits
// for the load (up to 8 s), then a little more for the module scripts' await.
export async function reportOf(name: string): Promise<string> {
  const until = Date.now() + 8000
  while (!reports.get(name)?.loaded && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
  if (reports.get(name)?.loaded) await new Promise((r) => setTimeout(r, 1500))
  const r = reports.get(name)
  if (!r) return 'No browser loaded it (the user may not have Codinger open), so script errors could not be checked.'
  if (!r.lines.length) return r.loaded ? 'It loaded with no script errors.' : 'It started to load, with no script errors so far.'
  return `It reported:\n${r.lines.slice(0, 30).join('\n')}`
}

// ---- the host ---------------------------------------------------------------------

const KINDS: Record<string, [string, string]> = {
  '.csv': ['csv', 'text/csv'], '.json': ['json', 'application/json'], '.md': ['markdown', 'text/markdown'], '.txt': ['text', 'text/plain'],
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'], '.svg': ['image', 'image/svg+xml'],
}
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', ...Object.fromEntries(Object.entries(KINDS).map(([k, [, t]]) => [k, t])) }
export const typeOf = (f: string) => TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream'

// Prolifica's bridge, kept in ~/.codinger/bridge.js. Asked for again at most once an
// hour (a conditional request, so an unchanged one costs nothing); the kept copy
// serves when Prolifica can't be reached.
let bridgeCheck = 0
async function bridge(): Promise<string> {
  let kept: { etag?: string; js: string } | null = null
  try { kept = JSON.parse(fs.readFileSync(BRIDGE + '.json', 'utf8')) } catch { /* none yet */ }
  if (kept && Date.now() - bridgeCheck < 3600_000) return kept.js
  bridgeCheck = Date.now()
  try {
    const r = await fetch(`${ORIGIN}/bridge.js`, { headers: kept?.etag ? { 'if-none-match': kept.etag } : {}, signal: AbortSignal.timeout(5000) })
    if (r.status === 200) {
      kept = { etag: r.headers.get('etag') ?? undefined, js: await r.text() }
      fs.writeFileSync(BRIDGE + '.json', JSON.stringify(kept))
    }
  } catch { /* offline: the kept copy */ }
  return kept?.js ?? `console.error('Codinger could not get the Prolifica bridge from ${ORIGIN}, so prolifica.data() is missing.')`
}

const esc = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

// What the page reports back about itself, for show_artifact (sendBeacon: no CORS needed).
const reporter = (name: string, base: string) => `<script>(()=>{const u='${base}/_report/${name}';const s=(m)=>{try{navigator.sendBeacon(u,JSON.stringify(m))}catch(e){}};s({t:'start'});`
  + `addEventListener('error',(e)=>{const el=e.target;s(el&&el!==window&&(el.src||el.href)?{t:'error',m:'Failed to load '+(el.src||el.href)}:{t:'error',m:String(e.message||e.error),at:e.filename?e.filename+':'+e.lineno:''})},true);`
  + `addEventListener('unhandledrejection',(e)=>s({t:'error',m:String(e.reason&&e.reason.stack||e.reason)}));`
  + `const ce=console.error;console.error=(...a)=>{s({t:'console',m:a.map(String).join(' ')});ce.apply(console,a)};addEventListener('load',()=>s({t:'load'}))})()</script>`

function inject(html: string, tags: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length)
  const doc = /<html(\s[^>]*)?>/i.exec(html)
  if (doc) return html.slice(0, doc.index + doc[0].length) + `<head>${tags}</head>` + html.slice(doc.index + doc[0].length)
  return tags + html
}

// base: the path the pages are under, through web.codinger.app ("/m/<machine>"), else "".
function page(src: Source, app: string, base: string): string {
  const m = src.manifest()
  const bindings: Record<string, unknown> = {}
  for (const [slot, file] of Object.entries(m.bindings ?? {})) {
    const local = !file.startsWith('prolifica:')
    const [kind, contentType] = KINDS[path.extname(file).toLowerCase()] ?? ['text', 'text/plain']
    const declared = m.slots?.[slot]?.kind
    bindings[slot] = { id: local ? file : file.slice(10), path: file, kind: declared && declared !== 'any' ? declared : kind, contentType, hash: local ? src.hash(file) : undefined }
  }
  // isle.id names the folder the bridge fetches data from (/<id>/data/<slot>): "<name>@<version>"
  // for an old version, and under base through web.codinger.app.
  const id = (base ? base.slice(1) + '/' : '') + (src.v == null ? src.name : `${src.name}@${src.v}`)
  const config = { isle: { id, title: m.title ?? src.name, version: src.v ?? 0 }, slots: m.slots ?? {}, bindings, app, origin: '' }
  // Only the page as it is now reports its errors (to show_artifact); an old version is for looking at.
  return inject(src.read('index.html')?.toString('utf8') ?? '', `${src.v == null ? reporter(src.name, base) : ''}<script>window.__PROLIFICA__=${esc(config)}</script><script src="${base}/bridge.js"></script>`)
}

export function startHost(port: number, uiOrigins: () => string[]): Promise<number> {
  const hosts = (p: number) => new Set([`127.0.0.1:${p}`, `localhost:${p}`])
  let allowed = hosts(port)
  const server = http.createServer(async (req, res) => {
    // Only this machine's names: a web page can't reach it through a rebound DNS name.
    if (!allowed.has(req.headers.host ?? '')) { res.writeHead(403).end(); return }
    const url = new URL(req.url ?? '/', 'http://x')
    // Through web.codinger.app (server/remote.ts): the pages are at artifacts.codinger.app/m/<machine>/.
    const at = String(req.headers['x-codinger-base'] ?? '')
    const prefix = /^\/m\/[a-z0-9-]{1,40}$/.test(at) ? at : ''
    const base = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
    const [, first, ...rest] = url.pathname.split('/').map((p) => { try { return decodeURIComponent(p) } catch { return '' } })
    try {
      if (url.pathname === '/bridge.js') { res.writeHead(200, { ...base, 'content-type': 'text/javascript' }).end(await bridge()); return }
      if (first === '_report' && req.method === 'POST' && NAME_RE.test(rest[0] ?? '')) {
        let s = ''
        for await (const c of req) { s += c; if (s.length > 20_000) break }
        const m = JSON.parse(s)
        if (m.t === 'start') reports.set(rest[0], { at: Date.now(), lines: [], loaded: false })
        const r = reports.get(rest[0])
        if (r && m.t === 'load') r.loaded = true
        else if (r && m.m && r.lines.length < 50) r.lines.push(`${m.t === 'console' ? 'console.error' : 'error'}: ${String(m.m).slice(0, 600)}${m.at ? ` (${m.at})` : ''}`)
        res.writeHead(204).end()
        return
      }
      // "<name>" is the artifact as it is now; "<name>@3" its version 3.
      const [name, v] = (first ?? '').split('@')
      const src = sourceOf(name, v ? Number(v) : undefined)
      if (!src) { res.writeHead(404, base).end('No such artifact'); return }
      if (!rest.length) { res.writeHead(301, { location: `${prefix}/${encodeURIComponent(first)}/${url.search}` }).end(); return }
      if (rest.length === 1 && rest[0] === '') {
        // The pane says which window holds it, so the bridge's messages go there and nowhere else.
        const app = url.searchParams.get('app') ?? ''
        res.writeHead(200, { ...base, 'content-type': 'text/html; charset=utf-8' }).end(page(src, uiOrigins().includes(app) ? app : uiOrigins()[0], prefix))
        return
      }
      const cors = { 'access-control-allow-origin': '*' }
      // What prolifica.data(slot) fetches: the bound file, or the dataset on Prolifica it names.
      let rel = rest.join('/')
      if (rest[0] === 'data' && rest.length === 2) {
        const file = src.manifest().bindings?.[rest[1]]
        if (file?.startsWith('prolifica:')) {
          const r = await call(`/api/data/${encodeURIComponent(file.slice(10))}/raw`).catch((e) => { throw Object.assign(e, { status: 502 }) })
          res.writeHead(200, { ...base, ...cors, 'content-type': typeof r === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }).end(typeof r === 'string' ? r : JSON.stringify(r))
          return
        }
        if (file) rel = file
      }
      const bytes = src.read(rel)
      if (!bytes) { res.writeHead(404, { ...base, ...cors }).end('No such file'); return }
      res.writeHead(200, { ...base, ...cors, 'content-type': typeOf(rel) }).end(bytes)
    } catch (e) {
      if (!res.headersSent) res.writeHead((e as { status?: number }).status ?? 500, base).end((e as Error).message)
    }
  })
  return new Promise((resolve) => {
    server.once('error', () => server.listen(0, '127.0.0.1'))   // the port is taken: any free one
    server.on('listening', () => { const p = (server.address() as { port: number }).port; allowed = hosts(p); resolve(p) })
    server.listen(port, '127.0.0.1')
  })
}

// Something about the artifacts changed: tell the listener once, a moment later.
let listener = () => {}
let timer: NodeJS.Timeout | null = null
export function artifactsChanged() {
  if (!timer) timer = setTimeout(() => { timer = null; listener() }, 200)
}

// Calls back when anything under the artifacts folder changes, or artifactsChanged() is called.
export function watchArtifacts(changed: () => void) {
  listener = changed
  try { fs.watch(ARTIFACTS, { recursive: true }, artifactsChanged) } catch { /* no recursive watch here: the list updates on tool calls */ }
}

// ---- publishing -------------------------------------------------------------------

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

// Send an artifact to Prolifica, as it is now or one of its versions (v): each data file
// that changed since the last time, then the page. The first publish makes a new page
// there; each later one a new version of it. A data file that changed goes up under a
// new name, so the page's earlier versions there keep showing the data they had.
// replace: the new version takes the place of the last one there (a squash of the two).
export async function publish(name: string, opts: { visibility?: Visibility; note?: string; v?: number; replace?: boolean }): Promise<{ published: ArtifactPublished; madePublic: string[] }> {
  if (checkArtifact(name)) throw new Error(checkArtifact(name)!)
  const local = opts.v ?? snapshot(name)
  saveRecord()
  const src = sourceOf(name, local)
  if (!src) throw new Error(`There is no version ${local} of ${name}.`)
  const m = src.manifest()
  const r = recOf(name)
  const before = r.published
  const next = before ? before.version + 1 : 1
  const data: ArtifactPublished['data'] = {}
  // Send one file, unless it went up as it is already. Its dataset id. It keeps its path under
  // data/ there, in a folder named after the artifact: data/media/a.jpg is <name>/media/a.jpg.
  const send = async (file: string, description?: string) => {
    if (data[file]) return { id: data[file].id, sent: false }   // bound twice, or a source that is bound too
    const bytes = src.read(file)
    if (!bytes) throw new Error(`Version ${local} has no ${file}.`)
    if (bytes.length > 20 * 1024 * 1024) throw new Error(`${file} is ${(bytes.length / 1048576).toFixed(1)} MB; Prolifica takes files of up to 20 MB.`)
    const hash = sha(bytes)
    const prev = before?.data[file]
    if (prev?.sha === hash) { data[file] = { ...prev }; return { id: prev.id, sent: false } }
    const sub = path.posix.normalize(file).replace(/^data\//, ''), ext = path.posix.extname(sub)
    const dpath = `${name}/${prev ? `${sub.slice(0, sub.length - ext.length)}.v${next}${ext}` : sub}`
    const q = new URLSearchParams({ path: dpath })
    if (description) q.set('description', description)
    const ds = await call(`/api/data?${q}`, { method: 'POST', headers: { 'content-type': typeOf(file) }, body: new Uint8Array(bytes) })
    data[file] = { sha: hash, id: ds.id, path: dpath }
    return { id: ds.id as string, sent: true }
  }
  // The source data first, with where it came from, so the bound data can say it was made from it.
  const sources = Object.entries(m.sources ?? {})
  const sourceIds: Record<string, string> = {}
  for (const [file, s] of sources) {
    const { id, sent } = await send(file, s.description ?? `The source data of "${m.title ?? name}", as it was collected.`)
    sourceIds[file] = id
    data[file].source = true
    const prov = { url: s.url, method: s.method, collectedAt: s.collected_at, notes: s.notes }
    if (!Object.values(prov).some((x) => x != null)) continue
    const said = JSON.stringify({ source: prov })
    if (!sent && before?.data[file]?.said === said) continue
    await call(`/api/data/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: said })
    data[file].said = said
  }
  const bindings: Record<string, string> = {}
  // Data Prolifica made public along the way: a page that is public already shows the bound data,
  // so the sources go public as soon as it says it was made from them.
  const madePublic: { path?: string; id: string }[] = []
  for (const [slot, file] of Object.entries(m.bindings ?? {})) {
    if (file.startsWith('prolifica:')) { bindings[slot] = file.slice(10); continue }
    bindings[slot] = (await send(file, m.slots?.[slot]?.description)).id
    if (file in sourceIds) continue
    // What it was made from. Set again when that changed; Prolifica keeps it apart from the file.
    const from = sources.filter(([f, s]) => f !== file && (!s.slots || s.slots.includes(slot))).map(([f]) => sourceIds[f]).sort()
    if (!from.length || JSON.stringify(data[file].from ?? []) === JSON.stringify(from)) continue
    const ds = await call(`/api/data/${encodeURIComponent(bindings[slot])}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ derived_from: from }) })
    madePublic.push(...(ds?.madePublic ?? []))
    // A Prolifica that does not take derived_from yet: it is tried again on the next publish.
    if (Array.isArray(ds?.derivedFrom) && from.every((id) => ds.derivedFrom.some((d: { id: string }) => d.id === id))) data[file].from = from
  }
  const visibility = opts.visibility ?? before?.visibility ?? 'public'
  const body = (id?: string) => JSON.stringify({
    id, html: src.read('index.html')?.toString('utf8') ?? '', title: m.title ?? name, description: m.description,
    shortTitle: m.short_title, viewName: m.view_name, slots: m.slots ?? {}, bindings, visibility, note: opts.note || undefined,
    parent: m.parent || undefined, instructions: src.read('instructions.md')?.toString('utf8'),
  })
  const post = (id?: string) => call('/api/isles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(id) })
  // Deleted on Prolifica since: publish it as a new page.
  const out = await post(before?.id).catch((e) => { if (before?.id && e.status === 404) return post(); throw e })
  const ids = Object.values(data).map((d) => d.id)
  const earlier = out.isle.id === before?.id ? before?.history ?? (before ? [{ version: before.version, local: before.local ?? 0, at: before.at }] : []) : []
  let history = [...earlier.map((h) => ({ ...h, data: h.data ?? (h.version === before?.version ? Object.values(before.data).map((d) => d.id) : undefined) })), { version: out.isle.version, local, at: Date.now(), data: ids }]
  if (opts.replace && before && out.isle.id === before.id) {
    const sq = await call(`/api/isles/${encodeURIComponent(before.id)}/squash`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: before.version, to: out.isle.version, note: opts.note || null }) })
    out.isle = sq.isle
    history = [...history.slice(0, -2), { version: sq.isle.version, local, at: Date.now(), data: ids }]
    // The replaced version's data that changed: deleted when no version left uses it (Prolifica
    // refuses when another page shows it, and then it stays), and the new file takes its name.
    // An earlier version with no record of its data might use it: then it stays too.
    const known = history.every((h) => h.data)
    for (const [file, d] of Object.entries(data)) {
      const old = before.data[file]
      if (!known || !old || old.id === d.id || history.some((h) => h.data!.includes(old.id))) continue
      try {
        await call(`/api/data/${encodeURIComponent(old.id)}`, { method: 'DELETE' })
        if (old.path) { await call(`/api/data/${encodeURIComponent(d.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: old.path }) }); d.path = old.path }
      } catch { /* still shown somewhere: it stays */ }
    }
  }
  r.published = { id: out.isle.id, url: `${ORIGIN}/i/${out.isle.id}`, version: out.isle.version, at: Date.now(), mtime: mtimeOf(dirOf(name)), visibility, data, local, history }
  saveRecord()
  return { published: r.published, madePublic: [...new Set([...madePublic, ...(out.madePublic ?? [])].map((d: { path?: string; id: string }) => d.path ?? d.id))] }
}
