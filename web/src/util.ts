import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import { highlight } from './highlight.ts'
import DOMPurify from 'dompurify'
import type { ImageRef } from '../../shared/types.ts'
import { MEDIA_URL, embedOf, mediaKind } from '../../shared/media.ts'
import { api, localId, media, state } from './store.ts'

export const marked = new Marked(
  markedHighlight({ emptyLangClass: 'hljs', langPrefix: 'hljs language-', highlight: (code, lang) => linkUrls(highlight(code, lang)) }),
  { gfm: true, breaks: false },
  {
    renderer: {
      codespan: urlCode,
      image: ({ href, text }) => mediaHtml(href, text),
      link(token) { return sessionLink(token.href, this.parser.parseInline(token.tokens)) },
    },
  },
)

// A web URL in inline code is a link too (the hook below opens it in a new tab).
function urlCode({ text }: { text: string }): string | false {
  return /^https?:\/\/\S+$/i.test(text) && `<a href="${escapeHtml(text).replace(/"/g, '&quot;')}"><code>${escapeHtml(text)}</code></a>`
}

// [title](session:<id>) names another session; a click shows it (main.tsx). DOMPurify
// drops a session: href, so the id goes in a data attribute. With no title ([](session:<id>))
// the link says the session's name; with a title that is not its name, a tip says the name.
function sessionLink(href: string, html: string): string | false {
  const id = /^session:([\w.-]+)$/.exec(href)?.[1]
  if (!id) return false
  const s = state.sessions.find((x) => localId(x.id) === id) ?? (id.length >= 6 ? state.sessions.find((x) => localId(x.id).startsWith(id)) : undefined)
  const said = html.replace(/<[^>]*>/g, '').trim()
  const tip = s && said && said !== s.title ? ` data-tip="${escapeHtml(s.title).replace(/"/g, '&quot;')}"` : ''
  return `<a class="session-link" href="#" data-session="${id}"${tip}>${said ? html : escapeHtml(s?.title ?? id)}</a>`
}

// So is a web URL in a code block: in the text between the highlighter's tags, up to a
// quote or a bracket (raw or escaped), without punctuation at its end.
const URL_IN_CODE = /(<[^>]*>)|https?:\/\/(?:(?!&quot;|&#39;|&#x27;|&lt;|&gt;)[^\s<>"'`])+/g
function linkUrls(html: string): string {
  return html.replace(URL_IN_CODE, (m, tag?: string) => {
    if (tag) return tag
    const url = m.replace(/[.,;:!?)\]]+$/, '')
    return `<a href="${url}">${url}</a>${m.slice(url.length)}`
  })
}

// A markdown image that is not one: a video, audio, a PDF, a page or another file an agent
// kept (server/media.ts), or a YouTube or Vimeo address. false: a plain image.
function mediaHtml(href: string, alt: string): string | false {
  const src = escapeHtml(href).replace(/"/g, '&quot;'), label = escapeHtml(alt).replace(/"/g, '&quot;')
  const embed = embedOf(href)
  if (embed) return `<iframe class="media-frame media-embed" src="${embed}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen aria-label="${label}"></iframe>`
  // A local path not kept yet: while the message streams in, or no such file.
  if (!/^(https?:|data:|\/api\/)/i.test(href)) return `<span class="media-missing">${escapeHtml(alt || href)}</span>`
  switch (mediaKind(href)) {
    case 'video': return `<video class="media-video" src="${src}" controls preload="metadata" playsinline></video>`
    case 'audio': return `<audio class="media-audio" src="${src}" controls preload="metadata"></audio>`
    case 'pdf': return `<iframe class="media-frame" src="${src}" aria-label="${label}"></iframe>`
    case 'page': return `<iframe class="media-frame" src="${src}" sandbox="allow-scripts allow-popups" aria-label="${label}"></iframe>`
    case 'file': return MEDIA_URL.test(href) ? `<a class="media-file" href="${src}" target="_blank">${escapeHtml(alt || 'Open the file')}</a>` : false
    default: return false
  }
}

// Frames only from mediaHtml: a kept PDF or page, or a YouTube or Vimeo player.
const FRAME = /^(\/api\/media\/[0-9a-f]{24}\.(pdf|html?)|https:\/\/www\.youtube-nocookie\.com\/embed\/[\w-]+|https:\/\/player\.vimeo\.com\/video\/\d+)$/
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  // Set for each frame: the list stays the same for later calls.
  if (data.tagName === 'iframe') data.allowedTags.iframe = FRAME.test((node as Element).getAttribute?.('src') ?? '')
})
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.tagName === 'IFRAME' && ['allow', 'allowfullscreen', 'sandbox'].includes(data.attrName)) data.forceKeepAttr = true
})

// Web links open in a new tab, everywhere markdown is rendered (all of it goes through DOMPurify).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

// Images and files the server keeps (/api/images/…, /api/media/…) come from the current session's machine.
export const served = (html: string) => html.replace(/(<(?:img|video|audio|iframe|a) [^>]*(?:src|href)=")(\/api\/(?:images|media)\/[^"]*)/g, (_, a: string, u: string) => a + media(u))

export function renderMd(md: string): string {
  return served(DOMPurify.sanitize(marked.parse(md, { async: false }) as string))
}

// What you write, and drafts you send back, is text, not HTML: a "<id>" in it
// shows as "<id>" instead of going missing as an unknown tag.
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const textMarked = new Marked(
  markedHighlight({ emptyLangClass: 'hljs', langPrefix: 'hljs language-', highlight: (code, lang) => linkUrls(highlight(code, lang)) }),
  { gfm: true, breaks: false, renderer: { html: ({ text }) => escapeHtml(text), codespan: urlCode } },
)
export function renderText(md: string): string {
  return served(DOMPurify.sanitize(textMarked.parse(md, { async: false }) as string))
}

export function renderInline(md: string): string {
  return served(DOMPurify.sanitize(marked.parseInline(md, { async: false }) as string))
}

export const kTokens = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

// How worn out a session is. Quality slips well before a 1M window is full,
// so tiredness is measured against at most 400k tokens.
export const fatigue = (used: number, window: number) => Math.min(1, used / Math.min(window || 200_000, 400_000))

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

// Pasted or dropped images: shrink big ones (the API rejects images over 5 MB
// and downsamples anything past ~1568px anyway), then upload.
const MAX_SIDE = 1568
export async function uploadImage(file: Blob, machine?: string): Promise<ImageRef> {
  let blob = file
  const bmp = await createImageBitmap(file).catch(() => null)
  if (bmp && (Math.max(bmp.width, bmp.height) > MAX_SIDE || file.size > 3_500_000)) {
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale))
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    blob = await canvas.convertToBlob({ type: file.type === 'image/png' && file.size < 8_000_000 ? 'image/png' : 'image/jpeg', quality: 0.88 })
  }
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = rej
    r.readAsDataURL(blob)
  })
  return api<ImageRef>('/api/images', 'POST', { dataUrl }, machine)
}

export function imagesFrom(dt: DataTransfer | null): File[] {
  return [...(dt?.files ?? [])].filter((f) => f.type.startsWith('image/'))
}

// iOS brings up the keyboard only for a focus inside a touch handler, and a comment card's
// field mounts after it. A hidden field takes the focus now; the card's field takes it over.
// Call it from the touch or click that opens the card. Only on a touch screen, and not while
// a card's field (or the hidden field) has the focus: taking it would empty a new card.
export function holdKeyboard() {
  if (!matchMedia('(pointer: coarse)').matches || document.activeElement?.closest('.note-card, [data-hold-keyboard]')) return
  const f = document.createElement('input')
  f.setAttribute('aria-hidden', 'true')
  f.setAttribute('data-hold-keyboard', '')
  f.tabIndex = -1
  f.style.cssText = 'position: fixed; top: 30%; left: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; font-size: 16px'
  document.body.appendChild(f)
  f.addEventListener('blur', () => f.remove(), { once: true })
  f.focus({ preventScroll: true })
  setTimeout(() => { if (document.activeElement === f) f.blur() }, 1000)
}

// The part of the page you see (above a phone's keyboard), in the coordinates that
// getBoundingClientRect gives, and where position: fixed puts top: 0 and left: 0 in them.
// With the keyboard open, iOS pans what you see, and the two do not agree: a fixed element
// at a box's top shows elsewhere. So place one at (x - fixed.left, y - fixed.top).
let probe: HTMLElement | null = null
export function visibleBox() {
  if (!probe) {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; visibility: hidden; pointer-events: none'
    document.body.appendChild(probe)
  }
  const p = probe.getBoundingClientRect(), vv = visualViewport
  const top = p.top + (vv?.offsetTop ?? 0), left = p.left + (vv?.offsetLeft ?? 0)
  return { top, left, bottom: top + (vv?.height ?? innerHeight), right: left + (vv?.width ?? innerWidth), fixed: { top: p.top, left: p.left } }
}
