// Who wrote which changed line of a file, for the Changes view (components/FileView.tsx). The server
// sends git's diff, who made each line from the versions it keeps after each tool call (server/changes.ts:
// a session, or 'you' for a change made outside the agents), and the edits each session made to the
// file since its last commit (server/index.ts authorsOf). A line the versions do not know (the file
// changed before Codinger kept versions of it) goes by the edits: an added line belongs to the session
// whose newest edit has it in its new text, a removed line to the one whose newest edit has it in its
// old text. A line that the edits of several sessions have, or of none, goes to the author with the
// most lines in its run of changed lines (git can pair two lines that are the same, such as "}",
// in another way than the versions do).

export type Author = { id: string; title: string; edits: { old?: string; new: string; ts: number }[] }
// who: the session's id, or 'you'; null when Codinger does not know.
export type DiffRow = { kind: 'add' | 'del' | 'ctx'; text: string; o: number; n: number; who?: string | null }
export type Hunk = { head: string; rows: DiffRow[] }

export function parseDiff(diff: string): Hunk[] {
  const out: Hunk[] = []
  let o = 0, n = 0
  for (const line of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) { o = Number(h[1]); n = Number(h[2]); out.push({ head: line, rows: [] }); continue }
    const cur = out.at(-1)
    if (!cur) continue   // the header: diff --git, index, ---, +++
    const text = line.slice(1)
    if (line.startsWith('+')) cur.rows.push({ kind: 'add', text, o, n: n++ })
    else if (line.startsWith('-')) cur.rows.push({ kind: 'del', text, o: o++, n })
    else if (line.startsWith(' ')) cur.rows.push({ kind: 'ctx', text, o: o++, n: n++ })
  }
  return out
}

export type Who = { add: Record<number, string>; del: Record<number, string> }

export function attribute(hunks: Hunk[], authors: Author[], who?: Who | null) {
  // For each line of text: the sessions whose edits have it, with the time of the newest such edit.
  const index = { add: new Map<string, Map<string, number>>(), del: new Map<string, Map<string, number>>() }
  const put = (m: Map<string, Map<string, number>>, text: string, id: string, ts: number) => {
    for (const l of text.split('\n')) {
      const k = l.trim()
      if (!k) continue
      const by = m.get(k) ?? new Map<string, number>()
      by.set(id, Math.max(ts, by.get(id) ?? 0))
      m.set(k, by)
    }
  }
  for (const a of authors) for (const e of a.edits) { put(index.add, e.new, a.id, e.ts); if (e.old) put(index.del, e.old, a.id, e.ts) }
  for (const h of hunks) {
    for (let i = 0; i < h.rows.length;) {
      if (h.rows[i].kind === 'ctx') { i++; continue }
      let j = i
      while (j < h.rows.length && h.rows[j].kind !== 'ctx') j++
      const run = h.rows.slice(i, j)
      i = j
      const known = (r: DiffRow) => r.kind === 'add' ? who?.add[r.n] : r.kind === 'del' ? who?.del[r.o] : undefined
      for (const r of run) r.who = known(r) ?? undefined
      if (run.every((r) => r.who)) continue
      const cands = run.map((r) => (r.kind === 'ctx' ? undefined : index[r.kind].get(r.text.trim())) ?? new Map<string, number>())
      // The run's most frequent author: from the lines the versions know, else from the edits.
      const count = new Map<string, number>()
      for (const r of run) if (r.who) count.set(r.who, (count.get(r.who) ?? 0) + 1)
      if (!count.size) cands.forEach((c) => { if (c.size === 1) { const id = [...c.keys()][0]; count.set(id, (count.get(id) ?? 0) + 1) } })
      const most = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      run.forEach((r, k) => {
        if (r.who) return
        const c = cands[k]
        r.who = c.size === 1 ? [...c.keys()][0]
          : c.size > 1 ? (most && c.has(most) ? most : [...c].sort((a, b) => b[1] - a[1])[0][0])
          : most
      })
    }
  }
}

// The hunks with a change of this session's, or one Codinger does not know the author of; a hunk that
// only others (other sessions, or you) changed goes.
export const mineOf = (hunks: Hunk[], me: string) => hunks.filter((h) => h.rows.some((r) => r.kind !== 'ctx' && (r.who === me || r.who == null)))

// The other sessions that changed lines of the file.
export const othersOf = (hunks: Hunk[], me: string) => new Set(hunks.flatMap((h) => h.rows.flatMap((r) => r.who && r.who !== me ? [r.who] : [])))
