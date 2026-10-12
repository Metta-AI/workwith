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

export type Ask = { id: string; question: string; options: string[] }

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

// The text Claude receives for an answer.
export function formatAnswer(id: string, question: string, choices: string[] | undefined, text: string): string {
  const q = question.split('\n')[0].slice(0, 200)
  const lines = [`**Answer to your question \`${id}\`** ("${q}"):`]
  if (choices?.length) lines.push(`Chose: ${choices.join('; ')}`)
  if (text.trim()) lines.push(text.trim())
  return lines.join('\n')
}

export function formatNote(quote: string, text: string): string {
  const q = quote.trim().split('\n').map((l) => `> ${l}`).join('\n')
  return text.trim() ? `${q}\n\n${text.trim()}` : q
}
