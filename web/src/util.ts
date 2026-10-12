import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ImageRef } from '../../shared/types.ts'
import { api } from './store.ts'

export const marked = new Marked({ gfm: true, breaks: false })

export function renderMd(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string)
}

export function renderInline(md: string): string {
  return DOMPurify.sanitize(marked.parseInline(md, { async: false }) as string)
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
export async function uploadImage(file: Blob): Promise<ImageRef> {
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
  return api<ImageRef>('/api/images', 'POST', { dataUrl })
}

export function imagesFrom(dt: DataTransfer | null): File[] {
  return [...(dt?.files ?? [])].filter((f) => f.type.startsWith('image/'))
}
