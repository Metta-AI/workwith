// Ask blocks: Claude writes a fenced block with the info string `ask`, and the
// UI renders it as a question you answer in place.
//
//   ```ask id=db
//   Which database should the cache use?
//   - SQLite
//   - Postgres
//   ```
//
// Lines starting with "- " are choices; everything else is the question.

import type { ArtifactAnchor } from './types.ts'

// draft: a <draft> (shared/blocks.ts): text Claude wrote for you to edit and send back.
// Its title is the question, and your text is the answer.
export type Ask = { id: string; question: string; options: string[]; draft?: string }

const FENCE = /^```ask\b([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm

export function parseAskBody(info: string, body: string, index: number): Ask {
  const id = /\bid\s*=\s*"?([\w.-]+)"?/.exec(info)?.[1] ?? `q${index + 1}`
  const question: string[] = []
  const options: string[] = []
  for (const line of body.split('\n')) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line)
    if (m) options.push(m[1].trim())
    else question.push(line)
  }
  return { id, question: question.join('\n').trim(), options }
}

// `start` is how many asks came before in the same message (they number q1, q2…).
export function parseAsks(markdown: string, start = 0): Ask[] {
  const out: Ask[] = []
  for (const m of markdown.matchAll(FENCE)) out.push(parseAskBody(m[1], m[2], start + out.length))
  return out
}

// The text Claude receives for an answer. A draft that comes back as Claude wrote
// it goes without its text, which Claude has; an edited one goes in full.
export function formatAnswer(id: string, question: string, choices: string[] | undefined, text: string, draft?: 'same' | 'edited'): string {
  const q = question.split('\n')[0].slice(0, 200)
  if (draft === 'same') return `**Draft \`${id}\`** ("${q}"): the user approved it as you wrote it.`
  if (draft === 'edited') { const f = '~'.repeat(Math.max(3, ...[...text.matchAll(/^~{3,}/gm)].map((m) => m[0].length + 1))); return `**Draft \`${id}\`** ("${q}"), as the user edited it:\n${f}\n${text.trim()}\n${f}` }
  const lines = [`**Answer to your question \`${id}\`** ("${q}"):`]
  if (choices?.length) lines.push(`Chose: ${choices.join('; ')}`)
  if (text.trim()) lines.push(text.trim())
  return lines.join('\n')
}

// A quote of more than `words` words goes to Claude as its first words and "…":
// Claude has the text already, and the prompt says such a quote stands for the
// whole passage. `head` keeps the line breaks of the quote, for the UI; `rest` is
// the part that is not sent ('' when the quote goes in full).
export function splitQuote(quote: string, words = 8): { head: string; rest: string } {
  const q = quote.trim()
  const m = q.match(new RegExp(`^(\\S+\\s+){${words - 1}}\\S+(?=\\s+\\S)`))
  return m ? { head: m[0], rest: q.slice(m[0].length) } : { head: q, rest: '' }
}

export function shortQuote(quote: string, words = 8): string {
  const { head, rest } = splitQuote(quote, words)
  return rest ? head.replace(/\s+/g, ' ') + ' …' : head
}

// Where a comment on an artifact is: the artifact, then the element (by data-pid, else by its
// CSS path), then what it quotes.
export function artifactWhere(a: ArtifactAnchor): string {
  const el = a.pid ? `[data-pid="${a.pid}"]${a.path ? ` > ${a.path}` : ''}` : a.path ? a.path : ''
  const ver = a.v != null ? ` (version ${a.v})` : ''
  if (a.text) return `artifact ${a.artifact}${ver}, text${el ? ` in ${el}` : ''}`
  return `artifact ${a.artifact}${ver}, element ${el || '<body>'}${a.tag ? ` (${a.tag})` : ''}`
}

// The agent cannot see the page, so it gets more of a quote from an artifact.
export const ARTIFACT_QUOTE_WORDS = 40
export function formatArtifactNote(a: ArtifactAnchor, quote: string, text: string): string {
  const q = `> [${artifactWhere(a)}] ${shortQuote(quote, ARTIFACT_QUOTE_WORDS).replace(/\n+/g, ' ')}`.trimEnd()
  return text.trim() ? `${q}\n\n${text.trim()}` : q
}

export function formatNote(quote: string, text: string): string {
  const q = shortQuote(quote).split('\n').map((l) => `> ${l}`).join('\n')
  return text.trim() ? `${q}\n\n${text.trim()}` : q
}
