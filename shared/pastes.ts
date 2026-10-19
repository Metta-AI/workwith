// A long text pasted into a field sits in the message as one block: a fence of
// backticks named "paste", one backtick longer than any run of backticks in the
// text, so nothing in it can close the fence early. Fields and sent messages show
// it as one pill that opens the whole text; Claude gets the text as it was pasted.

const TOKEN = /(?<!`)(`{3,})paste\n([\s\S]*?)\n\1(?!`)/g

// A paste this long or longer becomes a pill.
export const isLongPaste = (text: string) => text.length >= 1500 || text.split('\n').length > 20

export function pasteToken(text: string): string {
  const f = '`'.repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1)
  return `${f}paste\n${text}\n${f}`
}

// The text cut into runs of text and pastes, in order.
export function splitPastes(text: string): ({ text: string } | { paste: string })[] {
  const out: ({ text: string } | { paste: string })[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    out.push({ paste: m[2] })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

// For places that show text only.
export const withoutPastes = (text: string) => text.replace(TOKEN, (_, __, body: string) => `[${pasteLabel(body)}]`)

export function pasteLabel(text: string): string {
  const lines = text.split('\n').length
  return lines > 1 ? `Pasted text · ${lines.toLocaleString()} lines` : `Pasted text · ${text.length.toLocaleString()} characters`
}
