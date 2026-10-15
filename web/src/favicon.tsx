// The tab's icon is the critter of the session that was active last, in its
// look and pose, bobbing while it works. A red number counts the sessions that
// wait on you (questions or permission). With no sessions it
// is a critter in the accent colour.

import { useEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionMeta } from '../../shared/types.ts'
import type { Appearance } from '../../shared/appearance.ts'
import { Mascot } from './components/Mascot.tsx'
import { accentBody } from './appearance.ts'
import { fatigue } from './util.ts'

// Only what an agent asks of you: a finished turn does not need you.
const NEEDS_YOU = ['permission', 'asking']

function icon(props: React.ComponentProps<typeof Mascot>, count: number, up: boolean): string {
  let svg = renderToStaticMarkup(<Mascot {...props} size={32} />)
    .replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
    .replace(/viewBox="[^"]*"/, 'viewBox="0 -5 18 18"')
    .replace(/height="[^"]*"/, 'height="32"')
  if (up) svg = svg.replace('class="m-body"', 'class="m-body" transform="translate(0 -1)"')
  if (count) {
    const n = String(Math.min(count, 99))
    svg = svg.replace(/<\/svg>$/, `<circle cx="12.2" cy="0.8" r="5.4" fill="#e5534b" stroke="#fff" stroke-width=".7" shape-rendering="auto"/>`
      + `<text x="12.2" y="${n.length > 1 ? 3.3 : 3.7}" font-size="${n.length > 1 ? 7 : 8.4}" font-weight="600" text-anchor="middle" fill="#fff" font-family="system-ui, sans-serif">${n}</text></svg>`)
  }
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

export function useFavicon(sessions: SessionMeta[], appearance: Appearance | undefined) {
  const live = sessions.filter((s) => !s.archived)
  const last = live.filter((s) => s.started).sort((a, b) => b.lastActivity - a.lastActivity)[0]
  // Workers only: the lead is hidden, so its status would count something you cannot see.
  const count = live.filter((s) => s.kind === 'worker' && NEEDS_YOU.includes(s.status)).length
  // The count stands in for the critter's own badge ('idle' has none).
  const props: React.ComponentProps<typeof Mascot> = last
    ? { status: last.status, look: last.look, fatigue: fatigue(last.context.used, last.context.window), alert: 'idle' }
    : { status: 'idle', fatigue: 0, body: accentBody(appearance) }
  const moving = last?.status === 'working' && !appearance?.calm
  const key = JSON.stringify([props, count, moving])
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel=icon]')
    if (!link) return
    const frames = [icon(props, count, false), icon(props, count, true)]
    let f = 0
    link.href = frames[0]
    if (!moving) return
    const t = setInterval(() => { f ^= 1; link.href = frames[f] }, 450)
    return () => clearInterval(t)
  }, [key])
}
