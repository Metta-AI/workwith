// Makes a throwaway CODINER_HOME with made-up sessions, for screenshots of the real
// app that show none of your own sessions or folders:
//
//   node tools/demo-home.mjs [dir]       (dir defaults to /tmp/codiner-demo)
//   PORT=4646 CODINER_HOME=<dir>/home node server/index.ts --dev
//
// Then open http://localhost:4646. Nothing starts a claude process until you send.
import fs from 'node:fs'
const ROOT = process.argv[2] ?? '/tmp/codiner-demo'
const H = `${ROOT}/home`, P = `${ROOT}/projects`
fs.rmSync(H, { recursive: true, force: true })
fs.mkdirSync(`${H}/events`, { recursive: true }); fs.mkdirSync(`${H}/master`, { recursive: true })
for (const d of ['shop', 'api']) fs.mkdirSync(`${P}/${d}`, { recursive: true })
fs.writeFileSync(`${H}/AGENTS.md`, '# AGENTS.md\n')
fs.writeFileSync(`${H}/settings.json`, JSON.stringify({ masterAutoSend: false, autoModeMigrated: true }))
const now = Date.now()
const base = (o) => ({ kind: 'worker', parentId: null, model: null, permissionMode: 'auto', claudeSessionId: crypto.randomUUID(), started: true,
  createdAt: now - 3600e3, lastActivity: now - 60e3, status: 'idle', running: false, unread: false, compacting: false,
  context: { used: 40000, window: 1000000 }, pendingAsks: 0, lastText: '', error: null, inbox: [], ...o })

const reply = `<answer>
Yes. The page builds and the tests pass. I left the annual plan out, because the checkout cannot take it yet.
</answer>

The page is at \`/pricing\`. It shows three plans side by side, and the table below them compares the features.

<consider title="The prices on the page are from June" done>
Sales changed the Team price in August. Check the new figure with them before you publish.
</consider>

<ask id="path">
Where should the page go?
- /pricing
- /plans
</ask>

<details title="Every file changed">
- \`src/pages/pricing.tsx\`: the new page.
- \`src/data/plans.ts\`: the three plans and their features.
- \`src/styles/pricing.css\`: the cards and the table.
</details>

<run title="Restart the dev server">
npm run dev
</run>
`
let seq = 0
const ev = (o) => ({ seq: ++seq, ts: now - 600e3 + seq * 1000, ...o })
const tu = (id, name, input) => ({ type: 'tool_use', id, name, input })
const main = [
  ev({ t: 'user', parts: [{ kind: 'text', text: 'Can we ship the pricing page today?', images: [] }] }),
  ev({ t: 'assistant', msgId: 'm1', blocks: [{ type: 'text', text: 'I will build the page and run the tests.' }] }),
  ev({ t: 'assistant', msgId: 'm1', blocks: [tu('t1', 'Bash', { command: 'npm run build && npm test', description: 'Build and run the tests' })] }),
  ev({ t: 'tool_result', toolUseId: 't1', text: '✓ 42 tests passed', isError: false }),
  ev({ t: 'assistant', msgId: 'm2', blocks: [tu('t2', 'Edit', { file_path: `${P}/shop/src/data/plans.ts`, old_string: "annual: true", new_string: "annual: false" })] }),
  ev({ t: 'tool_result', toolUseId: 't2', text: 'ok', isError: false }),
  ev({ t: 'assistant', msgId: 'm3', blocks: [{ type: 'text', text: reply }] }),
  ev({ t: 'result', durationMs: 48000, isError: false }),
]
const sessions = [
  base({ id: 'demo0001', cwd: `${P}/shop`, title: 'Pricing page', status: 'asking', pendingAsks: 2, look: { color: 'teal', hat: 'beret', held: 'pencil' }, lastActivity: now - 30e3 }),
  base({ id: 'demo0002', cwd: `${P}/shop`, title: 'Fix the build', status: 'working', running: true, look: { color: 'moss', hat: 'hard-hat', face: 'smile' } }),
  base({ id: 'demo0003', cwd: `${P}/api`, title: 'Migrate to Postgres', status: 'permission', look: { color: 'grape', hat: 'wizard', eyewear: 'round-glasses' } }),
  base({ id: 'demo0004', cwd: `${P}/api`, title: 'Rate limits', status: 'waiting', look: { color: 'gold', face: 'moustache', neck: 'bowtie' } }),
  base({ id: 'demo0005', cwd: `${P}/api`, title: 'Long refactor', status: 'idle', context: { used: 300000, window: 1000000 }, look: { color: 'slate', held: 'coffee', hat: 'headphones' } }),
]
fs.writeFileSync(`${H}/sessions.json`, JSON.stringify(sessions, null, 1))
fs.writeFileSync(`${H}/events/demo0001.jsonl`, main.map((e) => JSON.stringify(e)).join('\n') + '\n')
for (const s of sessions.slice(1)) fs.writeFileSync(`${H}/events/${s.id}.jsonl`, '')
console.log(`Demo data in ${H}. Start it with:\n  PORT=4646 CODINER_HOME=${H} node server/index.ts --dev`)
