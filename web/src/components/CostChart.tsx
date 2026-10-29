// Line graphs for the cost page (CostPanel, UsageAudit): the work over time.
// Each section has a toggle between its graph and its table; the graph comes
// first, and this browser keeps your choice. A menu picks what the lines
// measure, and a click on a name in the legend hides its line or shows it.
//
// Colours (styles.css, --viz-*): the dataviz skill's reference palette without
// its orange, in order, and grey for the rest. Next to each other they pass its
// colour checks in light and dark. Some are low on a light page, so the lines
// have their names at their ends, and the table has every number.

import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { addDays, cents, daysIn, money } from '../../../shared/costs.ts'

export type View = 'graph' | 'table'
const read = <T,>(k: string): Record<string, T> => { try { return JSON.parse(localStorage.getItem(k) ?? '{}') } catch { return {} } }
function useSaved<T extends string>(store: string, k: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => read<T>(store)[k] ?? def)
  return [v, (n) => { setV(n); localStorage.setItem(store, JSON.stringify({ ...read<T>(store), [k]: n })) }]
}
export const useView = (k: string) => useSaved<View>('codinger.costViews', k, 'graph')

export function ViewToggle({ view, set }: { view: View; set(v: View): void }) {
  return (
    <div className="seg cost-view">
      <button className={view === 'graph' ? 'on' : ''} onClick={() => set('graph')}>Graph</button>
      <button className={view === 'table' ? 'on' : ''} onClick={() => set('table')}>Table</button>
    </div>
  )
}

// A heading with the toggle at its end (no toggle without set).
export function ChartHead({ title, view, set }: { title: string; view: View; set?(v: View): void }) {
  return <div className="cost-h-row"><h3 className="cost-h">{title}</h3>{set && <ViewToggle view={view} set={set} />}</div>
}

export const SLOTS = [1, 2, 3, 4, 5, 6].map((i) => `var(--viz-${i})`)
export const OTHER = 'var(--viz-other)'
const WORK = SLOTS[0], EFFECTIVE = SLOTS[1], IDEAL = SLOTS[2]

// values: null where the line has no value (a gap). remove: a × in the legend.
// fmt: its value in the readout, if not the chart's.
export type Line = { key: string; label: string; short?: string; color: string; values: (number | null)[]; bold?: boolean; remove?(): void; fmt?(n: number, i: number): string }

// Round up to 1, 2, 2.5 or 5 times a power of ten.
function nice(v: number) {
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v) ?? 10 * p
}
const cut = (s: string) => s.length > 17 ? `${s.slice(0, 16)}…` : s
export const dollars = (n: number) => n >= 1000 ? `$${+(n / 1000).toFixed(1)}k` : `$${+n.toFixed(2)}`
export const count = (n: number) => n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))

const H = 190, TOP = 10, BOTTOM = 22, LEFT = 46

// x: the label of each point. fmt: a value in the readout; tick: on the axis.
// extra: more lines in the readout. more: at the end of the legend.
// clip: the scale goes to 4 times the median of a line at most, and a higher point goes
// past the top (the readout has its value).
export function LineChart({ x, lines, fmt, tick = dollars, extra, more, clip }: {
  x: string[]; lines: Line[]; fmt(n: number): string; tick?(n: number): string; extra?(i: number): ReactNode; more?: ReactNode; clip?: boolean
}) {
  const cid = useId()
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  const [at, setAt] = useState<number | null>(null)
  const [off, setOff] = useState<Set<string>>(new Set())
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const shown = lines.filter((l) => !off.has(l.key))
  const n = x.length
  const ends = w >= 420                              // the names at the ends of the lines
  const right = ends ? 120 : 10
  const pw = Math.max(10, w - LEFT - right), ph = H - TOP - BOTTOM
  const pos = shown.map((l) => l.values.filter((v): v is number => v != null && v > 0).sort((a, b) => a - b))
  const hi = Math.min(Math.max(0, ...pos.flat()), clip ? Math.max(0, ...pos.map((v) => v.length ? v[Math.floor(v.length / 2)] * 4 : 0)) || Infinity : Infinity)
  const step = hi > 0 ? nice(hi / 4) : 1
  const top = Math.max(step, Math.ceil(hi / step - 1e-9) * step)
  const X = (i: number) => LEFT + (n > 1 ? i / (n - 1) * pw : pw / 2)
  const Y = (v: number) => TOP + ph - v / top * ph
  const ticks = [...Array(Math.round(top / step) + 1).keys()].map((i) => i * step)
  const xl = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [...Array(n).keys()]
  const last = (l: Line) => { for (let i = n - 1; i >= 0; i--) if (l.values[i] != null) return l.values[i]!; return null }
  // The runs of a line between its gaps.
  const runs = (l: Line) => {
    const out: number[][] = [[]]
    l.values.forEach((v, i) => { if (v == null) out.push([]); else out[out.length - 1].push(i) })
    return out.filter((r) => r.length)
  }

  // The names at the ends, pushed apart so they do not overlap.
  const labels = shown.filter((l) => last(l) != null).map((l) => ({ l, y: Y(Math.min(last(l)!, top)) })).sort((a, b) => a.y - b.y)
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14)
  const over = labels.length ? labels[labels.length - 1].y - (TOP + ph) : 0
  if (over > 0) for (const lb of labels) lb.y -= over

  const move = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const i = n > 1 ? Math.round((e.clientX - r.left - LEFT) / pw * (n - 1)) : 0
    setAt(Math.min(n - 1, Math.max(0, i)))
  }
  const flip = (k: string) => setOff((s) => { const o = new Set(s); if (!o.delete(k)) o.add(k); return o })

  return (
    <div className="line-chart" ref={box}>
      <div className="lc-legend">
        {lines.map((l) => <span key={l.key} className={`lc-key${off.has(l.key) ? ' off' : ''}${l.bold ? ' bold' : ''}`}>
          <button aria-pressed={!off.has(l.key)} onClick={() => flip(l.key)}><i style={{ background: l.color }} />{l.label}</button>
          {l.remove && <button className="lc-x" aria-label={`Remove ${l.label}`} onClick={l.remove}>×</button>}
        </span>)}
        {more}
      </div>
      <svg width={w} height={H} onPointerMove={move} onPointerLeave={() => setAt(null)}>
        {ticks.map((t) => <g key={t}>
          <line className="lc-grid" x1={LEFT} x2={LEFT + pw} y1={Y(t)} y2={Y(t)} />
          <text className="lc-axis" x={LEFT - 6} y={Y(t)} dy="0.32em" textAnchor="end">{tick(t)}</text>
        </g>)}
        {xl.map((i) => <text key={i} className="lc-axis" x={X(i)} y={H - 6} textAnchor={n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle'}>{x[i]}</text>)}
        <clipPath id={cid}><rect x={0} y={TOP - 4} width={w} height={ph + 8} /></clipPath>
        <g clipPath={`url(#${cid})`}>{shown.flatMap((l) => runs(l).map((r) => r.length > 1
          ? <polyline key={`${l.key}:${r[0]}`} className="lc-line" stroke={l.color} points={r.map((i) => `${X(i)},${Y(l.values[i]!)}`).join(' ')} />
          : <circle key={`${l.key}:${r[0]}`} cx={X(r[0])} cy={Y(l.values[r[0]]!)} r={3} fill={l.color} />))}</g>
        {ends && labels.map(({ l, y }) => <text key={l.key} className={`lc-end${l.bold ? ' bold' : ''}`} x={LEFT + pw + 8} y={y} dy="0.32em">{cut(l.short ?? l.label)}</text>)}
        {at != null && <g>
          <line className="lc-cross" x1={X(at)} x2={X(at)} y1={TOP} y2={TOP + ph} />
          {shown.filter((l) => l.values[at] != null).map((l) => <circle key={l.key} className="lc-dot" cx={X(at)} cy={Y(Math.min(l.values[at]!, top))} r={4} fill={l.color} />)}
        </g>}
      </svg>
      {at != null && <div className="lc-tip" style={X(at) > w / 2 ? { right: w - X(at) + 12 } : { left: X(at) + 12 }}>
        <b>{x[at]}</b>
        {[...shown].sort((a, b) => (b.values[at] ?? -1) - (a.values[at] ?? -1)).map((l) => <div key={l.key}><i style={{ background: l.color }} /><b>{l.values[at] == null ? '–' : (l.fmt ?? fmt)(l.values[at]!, at)}</b> {l.label}</div>)}
        {extra?.(at)}
      </div>}
    </div>
  )
}

// What the lines measure.
export type Measure = 'plans' | 'work' | 'etc' | 'used' | 'tokens'
const NAMES: Record<Measure, string> = { plans: 'what each plan costs', work: 'API work', etc: 'effective cost', used: 'plan usage', tokens: 'tokens' }
// Utilization: plan usage as a percent of the plan cost.
export const util = (n: number) => n > 0 && n < 0.5 ? '<1%' : `${Math.round(n)}%`
export const useMeasure = (k: string, def: Measure) => useSaved<Measure>('codinger.costMeasures', k, def)

export function MeasurePick({ value, set, options }: { value: Measure; set(m: Measure): void; options: Measure[] }) {
  return (
    <label className="settings-check lc-measure">
      Show
      <select value={value} onChange={(e) => set(e.target.value as Measure)}>{options.map((m) => <option key={m} value={m}>{NAMES[m]}</option>)}</select>
    </label>
  )
}

// The work of one day, on all machines: dollars at API prices, tokens in (with
// the cache) and out.
export type Totals = { usd: number; tin: number; tout: number }

// The work over time, in buckets of days (one day each, or a week, ...).
// price: what you pay a month. itc: your price for each API dollar at full utilization.
// rolling: the effective cost of a one-day bucket is over the 7 days up to it.
// plans: the lines of the plans measure, if it has one.
export function WorkChart({ id, buckets, tot, price, itc, rolling, plans }: {
  id: string; buckets: { label: string; days: string[] }[]; tot(day: string): Totals | undefined
  price: number | null; itc: number | null; rolling?: boolean; plans?: Line[]
}) {
  const options: Measure[] = [...plans ? ['plans' as const] : [], 'work', ...price != null ? ['etc' as const] : [], ...itc != null && price != null ? ['used' as const] : [], 'tokens']
  const [pick, setPick] = useMeasure(id, options[0])
  const m = options.includes(pick) ? pick : options[0]
  const sum = (days: string[]) => days.reduce((s, d) => { const t = tot(d); if (t) { s.usd += t.usd; s.tin += t.tin; s.tout += t.tout } return s }, { usd: 0, tin: 0, tout: 0 })
  const per = buckets.map((b) => sum(b.days))
  const day = price != null ? price * 12 / 365 : 0
  const pay = buckets.map((b) => day * b.days.length)
  const span = (b: { days: string[] }) => rolling ? daysIn(addDays(b.days[b.days.length - 1], -6), b.days[b.days.length - 1]) : b.days
  const etc = buckets.map((b) => { const d = span(b), u = sum(d).usd; return u > 0 ? day * d.length / u : null })
  const size = buckets[0]?.days.length ?? 1
  const plan = { key: 'price', label: `${size === 1 ? 'Daily' : size === 7 ? 'Weekly' : 'Monthly'} plan cost`, color: OTHER, values: pay }

  const lines: Line[] = m === 'plans' ? plans!
    : m === 'work' ? [{ key: 'work', label: 'API work', color: WORK, values: per.map((t) => t.usd) }, plan]
    : m === 'etc' ? [{ key: 'etc', label: 'Effective cost', color: EFFECTIVE, values: etc }, ...itc != null ? [{ key: 'itc', label: 'Ideal cost (at full utilization)', short: 'Ideal cost', color: IDEAL, values: buckets.map(() => itc) }] : []]
    : m === 'used' ? [{ key: 'used', label: 'Plan usage', color: IDEAL, values: per.map((t) => t.usd * itc!), fmt: (v, i) => `${money(v)} (${util(pay[i] ? v / pay[i] * 100 : 0)} utilization)` }, plan]
    : [{ key: 'in', label: 'Tokens in', color: WORK, values: per.map((t) => t.tin) }, { key: 'out', label: 'Tokens out', color: EFFECTIVE, values: per.map((t) => t.tout) }]
  const note = {
    plans: 'What each plan would have cost you, with the extra usage you would have needed.',
    work: 'API work is what Claude Code used, at API prices. Plan cost is what your plan cost for the same days.',
    etc: `Effective cost is what each API dollar cost you, ${rolling ? 'over the 7 days up to each day' : 'in each of them'}. Ideal cost is what it would cost at full utilization: if you used all of your plan's weekly limit.`,
    used: `Plan usage is how much of your plan the work used, in dollars of what you pay: each API dollar uses ${itc != null ? cents(itc) : '–'} of it. Plan cost is what you pay for ${rolling ? 'each day' : 'each week'}. Utilization is plan usage as a percent of the plan cost; when the two lines meet, it is 100%.${rolling ? ' A day can go past it, because the limit is for a week.' : ''}`,
    tokens: 'Tokens in include the tokens read from the cache. Click a name to hide its line.',
  }[m]
  return (
    <div>
      <MeasurePick value={m} set={setPick} options={options} />
      <LineChart key={m} x={buckets.map((b) => b.label)} lines={lines} fmt={m === 'etc' ? cents : m === 'tokens' ? count : money} tick={m === 'etc' ? cents : m === 'tokens' ? count : dollars} clip={m === 'etc'} />
      <p className="muted cost-note">{note}</p>
    </div>
  )
}
