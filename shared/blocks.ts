// Sections Claude marks in its text, as XML tags on their own lines:
//
//   <answer> … </answer>                the direct answer; the UI marks it
//   <details title="…"> … </details>    supporting detail, shown closed
//   <consider title="…"> … </consider>  an item that wants the user's reply or dismissal;
//                                       with `done`, something to do, marked done when it is
//   <ask id="…"> … </ask>               a question: its text, then "- " lines as choices
//   <run title="…"> … </run>            a command for the user to run; the UI offers a button
//   <draft id="…" title="…"> … </draft> text for the user to edit and send back (a commit
//                                       message, an email); an item, answered like an <ask>
//
// Markdown works inside, and sections nest. Lines inside code fences are left
// alone. A section still open at the end (a reply still streaming) holds what
// has arrived so far. The older forms still parse: ```ask fences (asks.ts), and
// `:::summary` / `:::more Title` / `:::consider Title` … `:::`.

import { parseAskBody, parseAsks, type Ask } from './asks.ts'

export type SectionKind = 'answer' | 'details' | 'consider' | 'ask' | 'run' | 'draft'
export type Section = { kind: SectionKind; title: string; attrs: Record<string, string>; body: Segment[]; closed: boolean }
export type Segment = { text: string } | Section

const TAGS = 'answer|details|consider|ask|run|draft'
const OPEN = new RegExp(`^\\s*<(${TAGS})((?:\\s+[\\w-]+(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?)*)\\s*>(.*)$`)
const CLOSE = new RegExp(`^(.*?)</(${TAGS})>\\s*$`)
const LEGACY = /^:::\s*(summary|more|consider)\b\s*(.*)$/
const LEGACY_KIND: Record<string, SectionKind> = { summary: 'answer', more: 'details', consider: 'consider' }

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

export function segmentsOf(text: string): Segment[] {
  const root: Segment[] = []
  const stack: { body: Segment[]; sec?: Section; legacy?: boolean }[] = [{ body: root }]
  let buf: string[] = []
  let fence = ''
  const top = () => stack.at(-1)!
  const flush = () => { if (buf.length) top().body.push({ text: buf.join('\n') }); buf = [] }
  const open = (kind: SectionKind, attrs: Record<string, string>, legacy = false) => {
    flush()
    const sec: Section = { kind, title: attrs.title ?? '', attrs, body: [], closed: false }
    top().body.push(sec)
    stack.push({ body: sec.body, sec, legacy })
  }
  const close = () => { flush(); const s = stack.pop()!; s.sec!.closed = true }
  for (const line of text.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length)))) {
      fence = fence ? '' : f
      buf.push(line)
      continue
    }
    if (fence) { buf.push(line); continue }
    let m: RegExpExecArray | null
    if ((m = OPEN.exec(line))) {
      open(m[1] as SectionKind, attrsOf(m[2]))
      let rest = m[3]
      const c = CLOSE.exec(rest)
      if (c && c[2] === m[1]) { if (c[1].trim()) buf.push(c[1]); close(); continue }
      if (rest.trim()) buf.push(rest)
    } else if ((m = CLOSE.exec(line)) && stack.length > 1 && top().sec!.kind === m[2]) {
      if (m[1].trim()) buf.push(m[1])
      close()
    } else if ((m = LEGACY.exec(line))) {
      open(LEGACY_KIND[m[1]], { title: m[2].trim() }, true)
    } else if (/^:::\s*$/.test(line) && stack.length > 1 && top().legacy) {
      close()
    } else buf.push(line)
  }
  flush()
  // <details> written the HTML way: a <summary> line gives the title.
  const fix = (segs: Segment[]) => {
    for (const s of segs) {
      if ('text' in s) continue
      const first = s.body[0]
      if (s.kind === 'details' && !s.title && first && 'text' in first) {
        const t = /^\s*<summary>(.*?)<\/summary>\s*\n?/.exec(first.text)
        if (t) { s.title = t[1].trim(); first.text = first.text.slice(t[0].length) }
      }
      fix(s.body)
    }
  }
  fix(root)
  return root
}

// An <ask> section as an Ask. `index` counts the asks before it in the message.
export function askOf(sec: Section, index: number): Ask {
  const body = sec.body.map((s) => ('text' in s ? s.text : '')).join('\n')
  return parseAskBody(sec.attrs.id ? `id=${sec.attrs.id}` : '', body, index)
}

// A <draft> section as an Ask: the title is the question, the body the text to edit.
// `index` counts the drafts before it in the message (they number d1, d2…).
export function draftOf(sec: Section, index: number): Ask {
  const body = sec.body.map((s) => ('text' in s ? s.text : '')).join('\n').replace(/^\n+|\s+$/g, '')
  const id = /^[\w.-]+$/.test(sec.attrs.id ?? '') ? sec.attrs.id : `d${index + 1}`
  return { id, question: sec.title || 'Draft', options: [], draft: body }
}

// The command in a <run> section, without a code fence around it.
export function commandOf(sec: Section): string {
  const body = sec.body.map((s) => ('text' in s ? s.text : '')).join('\n').trim()
  return (/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(body)?.[2] ?? body).trim()
}

// Things in a message that want a response: questions and items to consider.
// Ids match what the UI renders: asks by their id (or q1, q2…), items c1, c2…
// done: the item is something to do, so it can be marked done (`done`, or it holds a <run>).
// parent: the item to consider it sits in, if any.
export type Item = ({ kind: 'ask'; id: string; label: string; ask: Ask } | { kind: 'consider'; id: string; label: string; done: boolean }) & { parent?: string }

export const isTask = (sec: Section): boolean => 'done' in sec.attrs || sec.body.some((s) => !('text' in s) && (s.kind === 'run' || isTask(s)))

export function itemsOf(text: string): Item[] {
  const out: Item[] = []
  let asks = 0, considers = 0, drafts = 0
  const walk = (segs: Segment[], parent?: string) => {
    const under = parent ? { parent } : {}
    for (const s of segs) {
      if ('text' in s) {
        const found = parseAsks(s.text, asks)
        asks += found.length
        for (const a of found) out.push({ kind: 'ask', id: a.id, label: a.question.split('\n')[0], ask: a, ...under })
      } else if (s.kind === 'ask' || s.kind === 'draft') {
        const a = s.kind === 'ask' ? askOf(s, asks++) : draftOf(s, drafts++)
        out.push({ kind: 'ask', id: a.id, label: a.question.split('\n')[0], ask: a, ...under })
      } else if (s.kind === 'consider') {
        const id = `c${++considers}`
        out.push({ kind: 'consider', id, label: s.title || 'Item', done: isTask(s), ...under })
        walk(s.body, id)
      } else walk(s.body, parent)
    }
  }
  walk(segmentsOf(text))
  return out
}

// The text Claude receives for items the user marked done.
export function formatDone(items: { key: string; label: string; text?: string; result?: string }[]): string {
  const one = (i: (typeof items)[number]) => `\`${i.key.split(':').pop()}\` (${i.label.slice(0, 120)})${i.text?.trim() ? `, with a problem: ${i.text.trim()}` : ''}`
  const results = items.filter((i) => i.result).map((i) => `\n\nResult for \`${i.key.split(':').pop()}\`:\n\`\`\`\n${i.result}\n\`\`\``).join('')
  return `**Marked done:** ${items.map(one).join('; ')}${results}`
}

// The text Claude receives for items the user saw and set aside.
export function formatDismissed(items: { key: string; label: string }[]): string {
  return `**Dismissed, no reply:** ${items.map((i) => `\`${i.key.split(':').pop()}\` (${i.label.slice(0, 120)})`).join('; ')}`
}
