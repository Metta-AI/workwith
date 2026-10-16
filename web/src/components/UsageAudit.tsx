// Where the work went (shared/usage.ts): spend at API prices and tokens by
// folder, for any span of days, with the conversations behind each folder.
// Count by the project each call worked on, or by the folder the conversation
// ran in. On one machine or all of them: each server keeps a copy of your
// other machines' ledgers (server/usage.ts).
//
// Two prices for the work, from your plan (CostPanel gives them):
// - ETC, effective token cost: your plan's price over these days, shared out
//   over the API work all your machines did in them.
// - ITC, ideal token cost: what the work would cost you if you used all of
//   your plan's weekly limit.
// And the use outside Claude Code (chats on claude.ai and in the apps,
// Cowork): claude.ai reports the weekly limit by product, as a share of a
// week, and a full week is worth weekCeil of API work. Also the size of Codinger's copy of the
// transcripts, and a CSV of the whole ledger for an audit somewhere else.

import { Fragment, useEffect, useState } from 'react'
import { api } from '../store.ts'
import { cents, daysAgo, fmtDay, money, today } from '../../../shared/costs.ts'
import { addTok, noTok, tokIn, type Ledger, type Tok, type UsageConv, type UsageReply } from '../../../shared/usage.ts'

type Span = '7' | '30' | 'month' | 'last-month' | 'all'
const SPANS: [Span, string][] = [['7', 'the last 7 days'], ['30', 'the last 30 days'], ['month', 'this month'], ['last-month', 'last month'], ['all', 'all time']]

function range(s: Span): [string, string] {
  const t = today()
  if (s === '7') return [daysAgo(6), t]
  if (s === '30') return [daysAgo(29), t]
  if (s === 'month') return [`${t.slice(0, 7)}-01`, t]
  if (s === 'last-month') { const d = new Date(+t.slice(0, 4), +t.slice(5, 7) - 1, 0); const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; return [`${m}-01`, `${m}-${String(d.getDate()).padStart(2, '0')}`] }
  return ['0000', t]
}
const parse = (k: string) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime() }
const daysIn = (from: string, to: string) => Math.round((parse(to) - parse(from)) / 86_400_000) + 1

const home = (p: string) => { const h = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/.exec(p)?.[1]; return h ? '~' + p.slice(h.length) : p }
const count = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))
const bytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

// price: what you pay a month. weekCeil: a full week of your plan, in dollars of API work.
export function UsageAudit({ price, weekCeil }: { price: number | null; weekCeil: number | null }) {
  const [u, setU] = useState<UsageReply | null>(null)
  const [on, setOn] = useState<string>('all')
  const [span, setSpan] = useState<Span>('30')
  const [by, setBy] = useState<'worked' | 'ran'>('worked')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let live = true, t: ReturnType<typeof setTimeout> | undefined
    // The first read of the transcripts takes a while: look again soon until it is done.
    const get = () => api<UsageReply>('/api/usage', 'GET').then((r) => { if (live) setU(r); return r.scanning || !r.archive.at }, () => false)
      .then((soon) => { if (live) t = setTimeout(get, soon ? 15_000 : 5 * 60_000) })
    void get()
    return () => { live = false; clearTimeout(t) }
  }, [])
  if (!u) return <div className="muted">Reading the usage ledger…</div>

  const all: Ledger[] = [u, ...u.others]
  const shown = on === 'all' ? all : all.filter((l) => l.machine === on)
  const since = all.map((l) => l.since).filter((x): x is string => !!x).sort()[0] ?? today()
  let [from, to] = range(span)
  if (from < since) from = since
  if (to > today()) to = today()
  const inSpan = (d: string) => d >= from && d <= to
  // Tokens by folder in the span.
  const folders = new Map<string, Tok>()
  for (const l of shown) for (const [d, x] of Object.entries(l[by])) if (inSpan(d)) for (const [p, t] of Object.entries(x)) addTok(folders.get(p) ?? (folders.set(p, noTok()), folders.get(p)!), t)
  const total = [...folders.values()].reduce((s, t) => s + t.usd, 0)
  const rows = [...folders].sort((a, b) => b[1].usd - a[1].usd)
  // What each conversation spent in the span for one folder.
  const convsOf = (folder: string) => shown.flatMap((l) => l.convs.map((c) => {
    let usd = 0
    for (const [d, x] of Object.entries(c.spend)) if (inSpan(d)) for (const [p, n] of Object.entries(x)) if (by === 'ran' ? c.home === folder : p === folder) usd += n
    return { c, usd, machine: l === u ? null : l.label ?? l.machine }
  })).filter((x) => x.usd >= 0.005).sort((a, b) => b.usd - a.usd)

  // Your plan's cost for each dollar of API work: over these days (ETC), and at full use (ITC).
  // The plan pays for every machine's work, so ETC shares it over all of them.
  const days = from <= to ? daysIn(from, to) : 0
  const planCost = price != null ? price * 12 / 365 * days : null
  let allUsd = 0
  for (const l of all) for (const [d, x] of Object.entries(l.ran)) if (inSpan(d)) for (const t of Object.values(x)) allUsd += t.usd
  const etc = planCost != null && allUsd ? planCost / allUsd : null
  const itc = price != null && weekCeil ? price * 12 / 52 / weekCeil : null
  const rate = { etc, itc }

  // Use outside Claude Code, in dollars of API work: each product's share of the
  // weekly limit in the span, at what a full week is worth. All machines share it.
  const outside: { key: string; name: string; usd: number }[] = []
  if (weekCeil && on === 'all') {
    const share: Record<string, number> = {}
    for (const [d, x] of Object.entries(u.surfaces.days)) if (inSpan(d)) for (const [k, n] of Object.entries(x)) if (k !== 'claude_code') share[k] = (share[k] ?? 0) + n
    for (const [k, n] of Object.entries(share)) if (n > 0) outside.push({ key: k, name: u.surfaces.names[k] ?? k, usd: n * weekCeil })
    if (!outside.length && Object.keys(u.surfaces.days).some(inSpan)) outside.push({ key: '-', name: 'none', usd: 0 })
  }

  return (
    <div>
      <h3 className="cost-h">Where the work went</h3>
      <label className="settings-check">
        API work in
        <select value={span} onChange={(e) => setSpan(e.target.value as Span)}>{SPANS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        by
        <select value={by} onChange={(e) => { setBy(e.target.value as 'worked' | 'ran'); setOpen(null) }}>
          <option value="worked">the project it worked on</option>
          <option value="ran">the folder the conversation ran in</option>
        </select>
        {u.others.length > 0 && <>on
          <select value={on} onChange={(e) => { setOn(e.target.value); setOpen(null) }}>
            <option value="all">all machines</option>
            {all.map((l) => <option key={l.machine} value={l.machine}>{l === u ? 'this machine' : l.label ?? l.machine}</option>)}
          </select>
        </>}
      </label>
      {(etc != null || itc != null) && total > 0 && <p className="cost-line">
        {planCost != null && <>Your plan cost {money(planCost)} for these {days} days, for {money(allUsd)} of API work{u.others.length ? ' on all machines' : ''}. </>}
        {etc != null && <>ETC: {cents(etc)} for each API dollar. </>}
        {itc != null && <>ITC: {cents(itc)} for each API dollar at full use.</>}
      </p>}
      {rows.length ? <table className="mcp-table cost-table usage-table">
        <thead><tr><th>Folder</th><th>API work</th><th>ETC</th><th>ITC</th><th>Share</th><th>Tokens in</th><th>Tokens out</th></tr></thead>
        <tbody>{rows.map(([p, t]) => <Fragment key={p}>
          <tr className="usage-row" onClick={() => setOpen(open === p ? null : p)}>
            <td className="usage-folder"><span className="usage-caret">{open === p ? '▾' : '▸'}</span>{home(p)}</td>
            <td>{money(t.usd)}</td><td>{fee(t.usd, etc)}</td><td>{fee(t.usd, itc)}</td>
            <td>{!total ? '–' : t.usd / total < 0.005 ? '<1%' : `${Math.round(t.usd / total * 100)}%`}</td>
            <td>{count(tokIn(t))}</td><td>{count(t.out)}</td>
          </tr>
          {open === p && <tr className="usage-convs"><td colSpan={7}><Convs list={convsOf(p)} by={by} folder={p} rate={rate} /></td></tr>}
        </Fragment>)}</tbody>
        {outside.length > 0 && <tbody>{outside.map((o) => <tr key={o.key} className="usage-outside">
          <td>Outside Claude Code: {o.name}</td><td>{money(o.usd)}</td><td>{fee(o.usd, etc)}</td><td>{fee(o.usd, itc)}</td><td></td><td>–</td><td>–</td>
        </tr>)}</tbody>}
        <tfoot><tr><td>All folders</td><td>{money(total)}</td><td>{fee(total, etc)}</td><td>{fee(total, itc)}</td><td></td><td></td><td></td></tr></tfoot>
      </table> : <p className="muted cost-note">{u.scanning ? 'Codinger is still reading the transcripts.' : 'No API work in this time.'}</p>}
      {u.scanning && rows.length > 0 && <p className="muted cost-note">Codinger is still reading the transcripts. The numbers will go up.</p>}
      <p className="muted cost-note">
        "The project it worked on" follows the files that the tools read or change. A call with no files counts for the last project the conversation worked on.
        Tokens in include the tokens read from the cache.
        ETC (effective token cost) is what the work cost you: your plan's price over these days, shared out over all the API work in them.
        ITC (ideal token cost) is what it would cost you if you used all of your plan's weekly limit.
        {outside.length > 0 && <> "Outside Claude Code" is your use in other products, as claude.ai reports it for your weekly limit, in dollars of API work at what a full week is worth. It is not in the total. claude.ai gives whole percents, so it shows in steps of about {money((weekCeil ?? 0) / 100)}.{u.surfaces.resetsAt && <> Your weekly limit resets on {new Date(u.surfaces.resetsAt).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.</>}</>}
        {u.others.length > 0 && <> Codinger reads the ledgers of your other machines every 30 minutes, through web.codinger.app, and keeps a copy: {u.others.map((l) => `${l.label ?? l.machine} (${l.at ? when(l.at) : 'not read yet'})`).join(', ')}.</>}
      </p>
      <p className="muted cost-note">
        Codinger keeps a copy of every Claude Code transcript in <code>{home(u.archive.dir)}</code>
        {u.archive.at ? <>: {bytes(u.archive.bytes)} in {u.archive.files.toLocaleString()} files</> : ''}.
        Claude Code deletes its own copies after 30 days. You can delete old files from the copy to get space back; the totals stay.
        {u.since && <> The ledger starts on {fmtDay(u.since)}.</>}
        {' '}<a href="#" onClick={(e) => { e.preventDefault(); csv(u) }}>Download the ledger as CSV</a>
      </p>
    </div>
  )
}

const fee = (usd: number, rate: number | null) => rate == null ? '–' : money(usd * rate)

function Convs({ list, by, folder, rate }: { list: { c: UsageConv; usd: number; machine: string | null }[]; by: 'worked' | 'ran'; folder: string; rate: { etc: number | null } }) {
  if (!list.length) return <span className="muted">No conversation spent more than half a cent here.</span>
  return (
    <table className="mcp-table cost-table usage-inner">
      <thead><tr><th>Conversation</th><th>{by === 'worked' ? 'Ran in' : ''}</th><th>API work</th><th>ETC</th><th>Prompts</th><th>Last</th></tr></thead>
      <tbody>{list.slice(0, 50).map(({ c, usd, machine }) => <tr key={`${machine}:${c.id}`}>
        <td className="usage-title">{c.title || c.id}</td>
        <td>{[by === 'worked' && c.home !== folder ? home(c.home) : '', machine ?? ''].filter(Boolean).join(' · ')}</td>
        <td>{money(usd)}</td><td>{fee(usd, rate.etc)}</td><td>{c.prompts}</td><td>{when(c.last)}</td>
      </tr>)}</tbody>
      {list.length > 50 && <tfoot><tr><td colSpan={6} className="muted">and {list.length - 50} more</td></tr></tfoot>}
    </table>
  )
}

// One line for each day, conversation and project worked on.
function csv(u: UsageReply) {
  const q = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  const out = ['day,machine,conversation,codinger_session,claude_sessions,ran_in,worked_on,usd']
  for (const l of [u, ...u.others]) for (const c of l.convs) for (const [d, x] of Object.entries(c.spend)) for (const [p, n] of Object.entries(x)) {
    out.push([d, q(l.label ?? l.machine), q(c.title), c.codinger ?? '', c.claude.join(' '), q(c.home), q(p), n.toFixed(4)].join(','))
  }
  out.splice(1, out.length - 1, ...out.slice(1).sort())
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([out.join('\n') + '\n'], { type: 'text/csv' }))
  a.download = `codinger-usage-${today()}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
