// Files an agent shows the user with show_file (server/index.ts): kept by content in
// ~/.codinger/media, served at /api/media/<name>, and shown in the conversation by kind.

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'page' | 'file'

const TYPES: Record<string, [MediaKind, string]> = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'], avif: ['image', 'image/avif'], svg: ['image', 'image/svg+xml'], bmp: ['image', 'image/bmp'], ico: ['image', 'image/x-icon'],
  mp4: ['video', 'video/mp4'], m4v: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mov: ['video', 'video/quicktime'], ogv: ['video', 'video/ogg'],
  mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'], m4a: ['audio', 'audio/mp4'], aac: ['audio', 'audio/aac'], ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'], flac: ['audio', 'audio/flac'],
  pdf: ['pdf', 'application/pdf'],
  html: ['page', 'text/html; charset=utf-8'], htm: ['page', 'text/html; charset=utf-8'],
  txt: ['file', 'text/plain; charset=utf-8'], md: ['file', 'text/markdown; charset=utf-8'], csv: ['file', 'text/csv; charset=utf-8'],
  json: ['file', 'application/json'], log: ['file', 'text/plain; charset=utf-8'],
}

const extOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name.split(/[?#]/)[0])?.[1].toLowerCase() ?? ''
export const mediaKind = (name: string): MediaKind => TYPES[extOf(name)]?.[0] ?? 'file'
export const mediaType = (name: string) => TYPES[extOf(name)]?.[1] ?? 'application/octet-stream'
// The extension a kept copy gets: its own when it is a plain one.
export const mediaExt = (name: string) => extOf(name) || 'bin'

export const MEDIA_URL = /^\/api\/media\/([0-9a-f]{24}\.[a-z0-9]{1,8})$/
// show_file's result names the kept copy on a line of its own.
export const mediaUrlIn = (result: string) => /^url: (\/api\/media\/\S+)$/m.exec(result)?.[1] ?? null

// A YouTube or Vimeo address, as a page that plays it in a frame.
export function embedOf(url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  const host = u.hostname.replace(/^(www|m)\./, '')
  const yt = host === 'youtu.be' ? u.pathname.slice(1) : host === 'youtube.com' ? u.searchParams.get('v') ?? /^\/(?:shorts|embed)\/([\w-]+)/.exec(u.pathname)?.[1] : null
  if (yt && /^[\w-]{6,}$/.test(yt)) return `https://www.youtube-nocookie.com/embed/${yt}`
  const vimeo = host === 'vimeo.com' && /^\/(\d+)/.exec(u.pathname)?.[1]
  return vimeo ? `https://player.vimeo.com/video/${vimeo}` : null
}
