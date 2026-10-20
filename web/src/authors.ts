// Which session wrote which changed line of a file, for the Changes view (components/FileView.tsx).
// The server sends git's diff and the edits each session made to the file since its last commit
// (server/index.ts authorsOf). An added line belongs to the session whose newest edit has it in its
// new text, a removed line to the one whose newest edit has it in its old text. A line that the
// edits of several sessions have, or of none (a blank line, a change made with a shell command or
// by hand), goes to the session with the most lines in its run of changed lines.

export type Author = { id: string; title: string; edits: { old?: string; new: string; ts: number }[] }
// who: the session's id; null when no session's edit has the line.
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

export function attribute(hunks: Hunk[], authors: Author[]) {
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
      const cands = run.map((r) => (r.kind === 'ctx' ? undefined : index[r.kind].get(r.text.trim())) ?? new Map<string, number>())
      const count = new Map<string, number>()
      cands.forEach((c) => { if (c.size === 1) { const id = [...c.keys()][0]; count.set(id, (count.get(id) ?? 0) + 1) } })
      const most = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      run.forEach((r, k) => {
        const c = cands[k]
        r.who = c.size === 1 ? [...c.keys()][0]
          : c.size > 1 ? (most && c.has(most) ? most : [...c].sort((a, b) => b[1] - a[1])[0][0])
          : most
      })
      i = j
    }
  }
}

// The hunks with a change of this session's, or one that no session's edit has (it may be its own,
// made with a shell command); a hunk that only other sessions changed goes.
export const mineOf = (hunks: Hunk[], me: string) => hunks.filter((h) => h.rows.some((r) => r.kind !== 'ctx' && (r.who === me || r.who == null)))

// The other sessions that changed lines of the file.
export const othersOf = (hunks: Hunk[], me: string) => new Set(hunks.flatMap((h) => h.rows.flatMap((r) => r.who && r.who !== me ? [r.who] : [])))
