// Coordination between sessions (COORDINATION.md in Codinger's data folder): the rules at the
// top with the actions and the projects (their names, and which actions change the same thing),
// then one line for each session's word (👎 not now, 👍 ready) on an action in a project, which
// agents grep and rewrite, so no one reads the whole file. Codinger
// writes the file when it is missing, and drops the status lines older than a day and those of
// its archived sessions. The rest of the file is the agents' and the user's.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA } from './store.ts'

export const COORDINATION = path.join(DATA, 'COORDINATION.md')
// As agents write it in a command: ~/.codinger/COORDINATION.md.
export const COORDINATION_SHOWN = COORDINATION.startsWith(os.homedir() + path.sep) ? `~${COORDINATION.slice(os.homedir().length)}` : COORDINATION

const RULES = `# Coordination between sessions

Sessions (Codinger agents, and other Claude sessions) use this file to agree before an action
that can undo the work of another session: a push, a deploy, a restart, an \`npm install\`.

Each line under "## Status" is one session's word on one action in one project:

    - 👎 <action> | <project> | <session id> | <time, UTC> | <why>
    - 👍 <action> | <project> | <session id> | <time, UTC> | <why>

- 👎: do not do it now. 👍: I am ready for it.
- <action>: one of the actions under "## Actions".
- <project>: the project's name under "## Projects", as it is written there.
- <session id>: your Codinger session id (or your Claude session id outside Codinger).
- Keep one line for each action, project and session. To change your word, rewrite your line.
- Do not read the whole file. Grep it, for example: \`grep '| codinger |' ${'$'}{FILE}\`

## Rules

1. When you deploy uncommitted work of a project, put a 👎 on \`deploy\` for that project: a
   push or another deploy would replace it.
2. When your work is committed (and pushed, if the user asked for it), change your line to 👍.
3. Before an action on a project, grep the project's lines. Look at the action, and at each
   action that the project's entry says changes the same thing. If another session has a 👎 on
   one of them, do not do the action: tell the user which session holds it, and why.
4. When each of those lines is 👍, or there is none, a session that the user asked to do the
   action can do it.
5. Remove your lines when your task is done, or when the user moves you to other work.
6. A line older than 24 hours does not count: write the time again when you renew your word.
   Codinger removes such lines, and the lines of its archived sessions.

## Actions

- \`push\`: a push to the project's main branch.
- \`deploy\`: a deploy of the project to where people use it (a site, a hub, a store).
- \`restart\`: a restart of the project's server that other sessions use.
- \`npm install\`: a change to the project's node_modules.

## Projects

One entry for each project: its name (in lowercase, usually its folder's name), its folder, and
what its actions change, above all where two actions change the same thing. Add a project the
first time you work in it, and update its entry when you learn more.

- \`codinger\`: ~/Projects/codinger. \`push\` to main also deploys web.codinger.app
  (.github/workflows/deploy-web.yml), so \`push\` and \`deploy\` change the same thing.
  \`deploy\`: \`npx wrangler deploy\` in remote/ (web.codinger.app, from the working tree).
  \`restart\`: \`curl -s -X POST http://127.0.0.1:4545/api/restart\` (Codinger itself).

## Status

`

export function initCoordination() {
  if (!fs.existsSync(COORDINATION)) fs.writeFileSync(COORDINATION, RULES.replace('${FILE}', COORDINATION_SHOWN))
}

// Drop the status lines older than a day, and those of Codinger sessions that are archived.
// known: every session id Codinger has; archived: those of them that are archived. The lines of
// other ids (other Claude sessions) stay for their day.
const DAY = 24 * 3600_000
export function pruneCoordination(known: Set<string>, archived: Set<string>, now = Date.now()) {
  let text: string
  try { text = fs.readFileSync(COORDINATION, 'utf8') } catch { return }
  const lines = text.split('\n')
  const keep = lines.filter((l) => {
    const m = /^- (?:👎|👍) [^|]*\|[^|]*\|\s*([\w.~-]+)\s*\|\s*([^|]*?)\s*\|/u.exec(l)
    if (!m) return true
    const at = Date.parse(m[2].replace(/Z?$/, 'Z').replace(/(T\d\d:\d\d)Z$/, '$1:00Z'))
    if (!Number.isNaN(at) && now - at > DAY) return false
    return !known.has(m[1]) || !archived.has(m[1])
  })
  if (keep.length !== lines.length) fs.writeFileSync(COORDINATION, keep.join('\n'))
}

// Claude Code sessions outside Codinger read ~/.claude/CLAUDE.md, not Codinger's prompt: a
// short section there points them to the file too. Codinger asks once to add it (main.tsx).
const CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md')
const POINTER = `
## Coordination: \`${COORDINATION_SHOWN}\`

Before an action that can undo another session's work (a push, a deploy, a restart, an
\`npm install\`), and when you deploy uncommitted work, follow \`${COORDINATION_SHOWN}\`: its
rules, actions and projects are at the top. Grep its status lines for your project; do not
read them all.
`
export function pointerMissing(): boolean {
  try { return !fs.readFileSync(CLAUDE_MD, 'utf8').includes('COORDINATION.md') } catch { return true }
}
export function addPointer() {
  if (!pointerMissing()) return
  fs.mkdirSync(path.dirname(CLAUDE_MD), { recursive: true })
  fs.appendFileSync(CLAUDE_MD, POINTER)
}
