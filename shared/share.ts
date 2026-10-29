// A session's transcript, published read-only at web.codinger.app/s/<id> (server/share.ts
// builds it, remote/ keeps it, web/src/share.tsx shows it). Anyone with the link can read it.

import type { Event } from './types.ts'

// tools: 'line' keeps each tool call as one line (its name and what it worked on), without its
// output; 'full' keeps what it was given and what came back. thinking: Claude's thinking.
// redact: things that look like keys, and email addresses, become [hidden]; the home folder becomes ~.
export type ShareOpts = { tools: 'line' | 'full'; thinking: boolean; redact: boolean }
export const DEFAULT_OPTS: ShareOpts = { tools: 'line', thinking: false, redact: true }

// files: the kept images and media it shows (/api/images/<name>, /api/media/<name>), by name.
export type Share = {
  v: 1
  title: string
  at: number                          // when it was published
  opts: ShareOpts
  accent?: string; surface?: string; font?: string   // the owner's look (shared/appearance.ts)
  events: Event[]
  files: string[]
}

// What publishing would leave out or let through, shown before it goes.
// found: secrets the scan saw (hidden, or published as they are when redact is off).
// skipped: files too big to publish.
export type Found = { kind: string; sample: string; where: string; n: number }
export type SharePreview = { share: Share; found: Found[]; skipped: { name: string; size: number }[]; bytes: number }

// The share a session has, once published (SessionMeta.share).
export type Published = { id: string; url: string; at: number; opts: ShareOpts }

export const SHARE_ID = /^[A-Za-z0-9]{16}$/
export const SHARE_FILE = /^[0-9a-f]{24}\.[a-z0-9]{1,8}$/
// A Worker takes a request body of at most 100 MB.
export const SHARE_FILE_MAX = 90 * 1024 * 1024
