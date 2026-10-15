// Choose the extra Claude Code flags a new session starts with: type to search the
// known ones (shared/flags.ts), or type any other flag, with its value, and press Enter.

import { useRef, useState } from 'react'
import { FLAG_OPTIONS, flagProblem, splitFlag, type FlagOption } from '../../../shared/flags.ts'
import { XIcon } from './Icons.tsx'

// Flags you can give more than once; any other one you add again replaces the one there.
const REPEATS = new Set(['--add-dir', '--plugin-dir'])
const text = (o: FlagOption) => o.value ? `${o.flag} ${o.value}` : o.flag

export function FlagPicker({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const q = query.trim().toLowerCase()
  const [qFlag] = splitFlag(q)
  const shown = FLAG_OPTIONS.filter((o) => !value.includes(text(o)) && (!q || text(o).includes(q) || o.help.toLowerCase().includes(q) || (!!o.needs && o.flag === qFlag)))
  // What you typed, when it is a flag the list doesn't have as it is: a value, or a flag it doesn't know.
  // (A flag the list has a value for each of, --effort, waits for one of them.)
  const typed = q.startsWith('-') && !FLAG_OPTIONS.some((o) => (text(o) === q && !o.needs) || (o.flag === q && o.value)) ? query.trim() : null
  const items: (FlagOption | string)[] = typed ? [typed, ...shown.filter((o) => !o.needs || o.flag !== qFlag)] : shown
  const needs = typed ? FLAG_OPTIONS.find((o) => o.flag === qFlag && o.needs) : undefined

  const add = (f: string) => {
    const p = flagProblem(f)
    if (p) { setErr(p); return }
    const [flag] = splitFlag(f)
    onChange([...value.filter((v) => v !== f && (REPEATS.has(flag) || splitFlag(v)[0] !== flag)), f])
    setQuery(''); setErr(null); setIndex(0)
  }
  const choose = (it: FlagOption | string) => {
    if (typeof it === 'string') return add(it)
    // A flag that takes a value waits for you to type it.
    if (it.needs) { setQuery(it.flag + ' '); setErr(null); setIndex(0); input.current?.focus(); return }
    add(text(it))
  }

  return (
    <div className="flag-picker">
      <div className="flag-box" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus() } }}>
        {value.map((f) => (
          <span key={f} className="flag-chip mono">{f}
            <button type="button" className="link" aria-label={`Remove ${f}`} onClick={() => onChange(value.filter((v) => v !== f))}><XIcon size={11} /></button>
          </span>
        ))}
        <input
          ref={input}
          className="mono"
          value={query}
          placeholder={value.length ? '' : 'None. Type to search, e.g. chrome'}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setIndex(0); setErr(null) }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !query && value.length) onChange(value.slice(0, -1))
            else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setIndex((i) => Math.min(i + 1, items.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            // Enter with nothing typed is left to the form: it creates the session.
            else if (e.key === 'Enter' && q) { e.preventDefault(); if (items[index]) choose(items[index]) }
            else if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false) }
          }}
        />
      </div>
      {err && <div className="flag-err">{err}</div>}
      {open && items.length > 0 && (
        <div className="dir-menu" onMouseDown={(e) => e.preventDefault()}>
          {items.map((it, i) => (
            <button type="button" key={typeof it === 'string' ? `typed:${it}` : text(it)} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => choose(it)}>
              {typeof it === 'string'
                ? <><span className="mono">{it}</span><span className="muted">{needs && !splitFlag(it)[1] ? `Type the ${needs.needs}, then press Enter` : needs ? needs.help : 'Add this flag'}</span></>
                : <><span className="mono">{text(it)}{it.needs && <span className="muted"> &lt;{it.needs}&gt;</span>}</span><span className="muted">{it.help}</span></>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
