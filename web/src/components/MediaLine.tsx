// The line a show_file call leaves in the conversation (server/index.ts: fileTool), with
// what it shows under it: an image, a video, audio, a PDF, a page, or a file to open.

import type { Block, Event } from '../../../shared/types.ts'
import { embedOf, mediaKind, mediaUrlIn, type MediaKind } from '../../../shared/media.ts'
import { machineOf, media } from '../store.ts'
import { FileIcon, GlobeIcon, ImageIcon } from './Icons.tsx'

export const SHOW_FILE = 'mcp__codinger__show_file'

const LABEL: Record<MediaKind, string> = { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', page: 'Page', file: 'File' }

export function MediaLine({ sid, b, result }: { sid: string; b: Extract<Block, { type: 'tool_use' }>; result?: Extract<Event, { t: 'tool_result' }> }) {
  const path = String(b.input?.path ?? '').trim()
  const caption = typeof b.input?.caption === 'string' ? b.input.caption.trim() : ''
  const failed = !!result && (result.isError || !result.text.startsWith('Shown'))
  const kept = result && !failed ? mediaUrlIn(result.text) : null
  const web = /^https?:\/\//i.test(path) ? path : null
  const src = failed ? null : kept ? media(kept, machineOf(sid)) : result ? web : null
  const embed = web && embedOf(web)
  let kind: MediaKind = embed ? 'video' : mediaKind(kept ?? path)
  // A page on the web mostly refuses to show in a frame: a link to it.
  if (web && kind === 'page') kind = 'file'
  const name = web ?? path.split(/[\\/]/).pop()
  const Icon = kind === 'image' || kind === 'video' ? ImageIcon : web ? GlobeIcon : FileIcon
  return (
    <div className={`tool codinger-line media-line${failed ? ' err' : ''}${result ? '' : ' running'}`}>
      <a className="tool-line" href={src ?? undefined} target="_blank" rel="noreferrer">
        <span className="tool-icon"><Icon size={13} /></span>
        <span className="tool-name">{web && kind === 'file' ? 'Link' : LABEL[kind]}</span>
        <span className="tool-sum">
          {caption || name}
          {caption && <span className="muted"> · {name}</span>}
          {failed && <span> · {result!.text.split('\n')[0]}</span>}
        </span>
      </a>
      {src && kind !== 'file' && (
        <div className="media-body">
          {kind === 'image' && <a href={src} target="_blank" rel="noreferrer"><img className="media-img" src={src} alt={caption || name} loading="lazy" /></a>}
          {kind === 'video' && (embed
            ? <iframe className="media-frame media-embed" src={embed} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen aria-label={caption || name} />
            : <video className="media-video" src={src} controls preload="metadata" playsInline />)}
          {kind === 'audio' && <audio className="media-audio" src={src} controls preload="metadata" />}
          {kind === 'pdf' && <iframe className="media-frame" src={src} aria-label={caption || name} />}
          {/* Served sandboxed (server/index.ts), so it never runs as Codinger. */}
          {kind === 'page' && <iframe className="media-frame" src={src} sandbox="allow-scripts allow-popups" aria-label={caption || name} />}
        </div>
      )}
    </div>
  )
}
