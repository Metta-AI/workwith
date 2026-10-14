// Autopilot in the session header (server/autopilot.ts): a goal and a budget to
// start it; while it runs, what is left, and a button to turn it off.

import { useEffect, useRef, useState } from 'react'
import type { BudgetUnit, SessionMeta } from '../../../shared/types.ts'
import { api, useStore } from '../store.ts'
import { pct } from '../cache.ts'

const UNITS: { v: BudgetUnit; label: string }[] = [
  { v: 'sevenDay', label: '% of weekly limit' },
  { v: 'fiveHour', label: '% of 5-hour limit' },
  { v: 'usd', label: 'dollars (API prices)' },
]
const AUTO = ['auto', 'bypassPermissions']

export const budgetLabel = (unit: BudgetUnit, x: number) =>
  unit === 'usd' ? `$${x.toFixed(2)}` : `${pct(x * 100)} of ${unit === 'fiveHour' ? '5h' : '7d'}`

export function AutopilotButton({ m }: { m: SessionMeta }) {
  const st = useStore()
  const ap = m.autopilot
  const on = !!ap && !ap.ended
  const [open, setOpen] = useState(false)
  const [goal, setGoal] = useState('')
  const [unit, setUnit] = useState<BudgetUnit>(ap?.unit ?? 'sevenDay')
  const [amount, setAmount] = useState(() => ap ? String(ap.unit === 'usd' ? ap.budget : +(ap.budget * 100).toFixed(2)) : '5')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  const auto = AUTO.includes(m.permissionMode)
  const n = Number(amount)
  const valid = n > 0 && (unit === 'usd' || n <= 100)
  const used = unit === 'usd' ? null : st.usage[unit]
  const start = async () => {
    await api(`/api/sessions/${m.id}/autopilot`, 'POST', { goal, unit, budget: unit === 'usd' ? n : n / 100 })
    setGoal('')
    setOpen(false)
  }
  const left = ap ? Math.max(0, ap.budget - ap.used) : 0
  return (
    <div className="menu-wrap" ref={box}>
      <button className={on ? 'autopilot-on' : ''} title={on ? `Autopilot: ${ap!.goal || 'the task so far'}` : 'Let Claude keep going on its own, within a budget'} onClick={() => setOpen(!open)}>
        {on ? `Autopilot · ${budgetLabel(ap!.unit, left)} left` : 'Autopilot'}
      </button>
      {open && (
        <div className="menu autopilot-pop">
          {on ? (
            <>
              <div><b>Goal:</b> {ap!.goal || 'the task so far'}</div>
              <div className="muted">Used {budgetLabel(ap!.unit, ap!.used)} of {budgetLabel(ap!.unit, ap!.budget)} in {ap!.turns} {ap!.turns === 1 ? 'turn' : 'turns'}. The budget is checked between turns.</div>
              <div className="autopilot-row"><button className="danger" onClick={() => { setOpen(false); void api(`/api/sessions/${m.id}/autopilot`, 'DELETE') }}>Turn off</button></div>
            </>
          ) : (
            <>
              <div className="muted">After each turn, Codinger tells Claude to go on, until the budget is spent or Claude stops to ask you.</div>
              {ap?.ended && <div className="muted">Last run ended: {ap.ended.reason}.</div>}
              <textarea rows={3} placeholder={m.started ? 'Goal (empty: go on with the task so far)' : 'Goal'} value={goal} onChange={(e) => setGoal(e.target.value)} />
              <div className="autopilot-row">
                <span>Budget</span>
                <input type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <select value={unit} onChange={(e) => setUnit(e.target.value as BudgetUnit)}>
                  {UNITS.map((u) => <option key={u.v} value={u.v}>{u.label}</option>)}
                </select>
              </div>
              {used != null && <div className="muted">You used {pct(used * 100)} of this limit so far.</div>}
              {!auto && (
                <div className="autopilot-row warn">
                  Autopilot needs auto mode.
                  <button onClick={() => void api(`/api/sessions/${m.id}`, 'PATCH', { permissionMode: 'auto' })}>Switch to auto mode</button>
                </div>
              )}
              <div className="autopilot-row"><button className="primary" disabled={!auto || !valid || (!m.started && !goal.trim())} onClick={() => void start()}>Start autopilot</button></div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
