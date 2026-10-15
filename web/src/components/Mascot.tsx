// A pixel critter per session. Its pose is the session's status; how worn out
// it looks is how full the context is (droopy eyes, sweat, then sleep). What it
// wears is its look, which each Claude picks for itself (shared/looks.ts). A session
// another session started (a child) wears red shoes, which Codinger gives it.

import type { Status } from '../../../shared/types.ts'
import type { Look } from '../../../shared/looks.ts'
import { BODY_COLORS, DRAWINGS, partsOf, rects } from './looks.tsx'
import { inkOn } from '../../../shared/appearance.ts'


// body: a colour of your own, in place of the look's; alert: whose badge to show, if not its own.
type Props = { status: Status; fatigue: number; size?: number; title?: string; look?: Look; body?: string; alert?: Status; child?: boolean }

// Drawn back to front.
const LAYERS = ['face', 'hair', 'neck', 'eyewear', 'hat', 'held'] as const

const SHOE = '#ff2a2a'

export function Mascot({ status, fatigue, size = 28, title, look = {}, body, alert, child }: Props) {
  // Looks saved before 'teal' became the default may still say 'classic'.
  const BODY = body ?? BODY_COLORS[look.color ?? 'teal'] ?? BODY_COLORS.teal
  const ink = (body ? inkOn(body) === '#ffffff' : look.color === 'midnight') ? '#e8ecff' : '#2a1f1a'
  const tired = fatigue >= 0.55
  const spent = fatigue >= 0.85
  const eyes = status === 'error' ? xEyes(ink) : spent && status !== 'working' ? sleepEyes(ink) : tired ? droopyEyes(ink) : openEyes(status, ink)
  const badge = BADGES[alert ?? status]
  const parts = LAYERS.map((slot) => ({ slot, ...partsOf(look[slot] ? (DRAWINGS[slot] as Record<string, any>)[look[slot]!] : undefined) }))
  return (
    <svg
      className={`mascot st-${status}${tired ? ' tired' : ''}${spent ? ' spent' : ''}`}
      width={size} height={size * 20 / 18} viewBox="0 -6 18 20" shapeRendering="crispEdges"
      style={{ filter: `saturate(${1 - fatigue * 0.55})` }}
      role="img" aria-label={title ?? status}
    >
      {title && <title>{title}</title>}
      <g className="m-body">
        {parts.map((p) => rects(p.back, `b${p.slot}`))}
        <rect x="3" y="3" width="10" height="1" fill={BODY} />
        <rect x="2" y="4" width="12" height="5" fill={BODY} />
        <rect x="3" y="9" width="10" height="1" fill={BODY} />
        <rect x="0" y="6" width="2" height="2" fill={BODY} className="m-arm-l" />
        <rect x="14" y="6" width="2" height="2" fill={BODY} className="m-arm-r" />
        {eyes}
        {parts.map((p) => rects(p.front, `f${p.slot}`))}
        {parts.map((p) => p.spin.length > 0 && <g key={`s${p.slot}`} className="m-spin">{rects(p.spin, `s${p.slot}`)}</g>)}
      </g>
      <g className="m-legs" fill={BODY}>
        <g className="m-leg a"><rect x="4" y="10" width="2" height="2" />{child && <rect x="3" y="10" width="3" height="2" fill={SHOE} />}</g>
        <g className="m-leg b"><rect x="10" y="10" width="2" height="2" />{child && <rect x="10" y="10" width="3" height="2" fill={SHOE} />}</g>
      </g>
      {tired && !spent && <rect className="m-sweat" x="14" y="2" width="1" height="2" fill="#7cc4ff" />}
      {spent && status !== 'working' && <text className="m-z" x="14" y="3" fontSize="4" fill="#9aa">z</text>}
      {badge && (
        <g className="m-badge">
          <rect x="13" y="0" width="5" height="5" rx="1" fill={badge.bg} shapeRendering="auto" />
          <text x="15.5" y="4" fontSize="4.2" fontWeight="700" textAnchor="middle" fill={badge.fg} fontFamily="system-ui">{badge.ch}</text>
        </g>
      )}
    </svg>
  )
}

export const BADGES: Partial<Record<Status, { ch: string; bg: string; fg: string }>> = {
  permission: { ch: '!', bg: '#f5b400', fg: '#2a1f1a' },
  asking: { ch: '?', bg: '#4c8dff', fg: '#fff' },
  waiting: { ch: '•', bg: '#3fb950', fg: '#fff' },
  error: { ch: '×', bg: '#e5534b', fg: '#fff' },
}

const openEyes = (status: Status, INK: string) => status === 'new'
  ? <><rect x="5" y="5" width="1" height="1" fill={INK} /><rect x="10" y="5" width="1" height="1" fill={INK} /></>
  : <><rect className="m-eye" x="5" y="4" width="1" height="2" fill={INK} /><rect className="m-eye" x="10" y="4" width="1" height="2" fill={INK} /></>
const droopyEyes = (INK: string) => <>
  <rect x="4" y="5" width="3" height="1" fill={INK} /><rect x="5" y="6" width="1" height="1" fill={INK} />
  <rect x="9" y="5" width="3" height="1" fill={INK} /><rect x="10" y="6" width="1" height="1" fill={INK} />
</>
const sleepEyes = (INK: string) => <><rect x="4" y="6" width="3" height="1" fill={INK} /><rect x="9" y="6" width="3" height="1" fill={INK} /></>
const xEyes = (INK: string) => <g fill={INK}>
  {[[4, 4], [6, 4], [5, 5], [4, 6], [6, 6], [9, 4], [11, 4], [10, 5], [9, 6], [11, 6]].map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="1" height="1" />)}
</g>

export const STATUS_LABEL: Record<Status, string> = {
  new: 'new', working: 'working', permission: 'needs permission', asking: 'has questions',
  waiting: 'your turn', idle: 'idle', error: 'error',
}
