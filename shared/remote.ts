// Remote access: what a machine's Codinger and the hub (remote/, a Cloudflare
// Worker) say to each other over the machine's one outbound WebSocket.
//
// The hub tunnels everything for <machine>.codinger.app through it: each HTTP
// request as a `req`, each browser WebSocket as a channel (`open`, `msg`,
// `close`). The machine replays them on its own server at 127.0.0.1, so that
// server sees what it sees from a local page.

// From the hub to a machine.
export type HubMsg =
  | { t: 'req'; id: string; method: string; path: string; headers: Record<string, string>; body?: string; art?: boolean } // body: base64; art: for the artifacts server (artifacts.codinger.app/m/<machine>/…)
  | { t: 'open'; chan: string; path: string; protocols: string[] }
  | { t: 'msg'; chan: string; data: string }
  | { t: 'close'; chan: string }
  | { t: 'hello'; name: string; label?: string; parts?: boolean } // on connect: the machine's name and display name here; parts: it takes answers in parts
  | { t: 'bye'; why: 'renamed' | 'forgotten' }      // connect again under the new name, or forget the token
  | { t: 'ack'; id: string }                        // a part went on to the browser: send another
  | { t: 'cancel'; id: string }                     // the browser stopped reading: send no more
  | { t: 'pong' }                                   // to the machine's ping (PING, PONG below)

// From a machine to the hub. A channel's messages come in batches.
export type MachineMsg =
  | { t: 'res'; id: string; status: number; headers: Record<string, string>; body: string; more?: boolean } // body: base64; more: it comes in parts
  | { t: 'part'; id: string; data: string; end?: boolean; failed?: boolean } // data: base64
  | { t: 'msgs'; chan: string; data: string[] }
  | { t: 'close'; chan: string }
  | { t: 'ping' }

// The machine's heartbeat. The hub's runtime answers it for any socket the hub still holds, without
// waking the hub; a WebSocket ping is not enough, as it gets an answer where the hub has lost the socket.
export const PING = JSON.stringify({ t: 'ping' } satisfies MachineMsg)
export const PONG = JSON.stringify({ t: 'pong' } satisfies HubMsg)

// A message over 32 MiB closes the socket, so a big answer comes in parts of PART_BYTES, with
// at most PARTS_AHEAD of them sent and not yet passed on (each `ack` lets one more go).
export const PART_BYTES = 1024 * 1024
export const PARTS_AHEAD = 4

// Request headers that go through to the machine, and response headers that come back.
export const REQ_HEADERS = ['content-type', 'accept', 'if-none-match', 'range']
// The sandbox of a page an agent shows (server/index.ts: /api/media, /file) must come through too.
export const RES_HEADERS = ['content-type', 'cache-control', 'etag', 'content-disposition', 'content-range', 'accept-ranges', 'last-modified', 'content-security-policy', 'x-content-type-options']

// A machine you connected, as web.codinger.app/_remote/machines lists it.
// name: fixed, it goes in /m/<name>/; label: the name the sidebar shows, if you gave one.
export type RemoteMachine = { name: string; label?: string; connected: boolean }

// A machine's name: lower-case letters, digits and dashes (it goes in /m/<name>/).
export const machineName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'machine'
