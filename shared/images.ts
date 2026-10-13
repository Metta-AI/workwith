// Images pasted into a reply sit in its text where they were pasted, as
// markdown image links to the uploaded file. Claude gets the text and the
// images in that order; sent messages render them in place.

const TOKEN = /!\[[^\]\n]*\]\((\/api\/images\/\w+\.(?:png|jpg|gif|webp))\)/g

export const imageToken = (url: string) => `![image](${url})`

// The text cut into runs of text and images, in order.
export function splitImages(text: string): ({ text: string } | { url: string })[] {
  const out: ({ text: string } | { url: string })[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    out.push({ url: m[1] })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

// For places that show text only.
export const withoutImages = (text: string) => text.replace(TOKEN, '[image]')

export const mediaTypeOf = (url: string) => `image/${url.split('.').pop()!.replace('jpg', 'jpeg')}`
