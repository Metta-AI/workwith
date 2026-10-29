// Files you attach to a message go into the session's directory (server: /api/fs/upload);
// the message names each one with a paperclip, so Claude knows to look there.

const TOKEN = /\u{1F4CE} `([^`\n]+)`/gu

export const fileToken = (name: string) => `\u{1F4CE} \`${name}\``

// The files a text names, in order.
export const filesIn = (text: string) => [...text.matchAll(TOKEN)].map((m) => m[1])

// The text cut into runs of text and files, in order.
export function splitFiles(text: string): ({ text: string } | { file: string })[] {
  const out: ({ text: string } | { file: string })[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    out.push({ file: m[1] })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
