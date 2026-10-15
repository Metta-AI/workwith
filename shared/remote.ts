// Remote access: what a machine's Codinger and the hub (remote/, a Cloudflare
// Worker) say to each other over the machine's one outbound WebSocket.
//
// The hub tunnels everything for <machine>.codinger.app through it: each HTTP
// request as a `req`, each browser WebSocket as a channel (`open`, `msg`,
// `close`). The machine replays them on its own server at 127.0.0.1, so that
// server sees what it sees from a local page.

// From the hub to a machine.
export type HubMsg =
  | { t: 'req'; id: string; method: string; path: string; headers: Record<string, string>; body?: string } // body: base64
  | { t: 'open'; chan: string; path: string; protocols: string[] }
  | { t: 'msg'; chan: string; data: string }
  | { t: 'close'; chan: string }
  | { t: 'hello'; name: string; label?: string }   // on connect: the machine's name and display name here
  | { t: 'bye'; why: 'renamed' | 'forgotten' }      // connect again under the new name, or forget the token

// From a machine to the hub. A channel's messages come in batches.
export type MachineMsg =
  | { t: 'res'; id: string; status: number; headers: Record<string, string>; body: string } // body: base64
  | { t: 'msgs'; chan: string; data: string[] }
  | { t: 'close'; chan: string }

// Request headers that go through to the machine, and response headers that come back.
export const REQ_HEADERS = ['content-type', 'accept', 'if-none-match', 'range']
export const RES_HEADERS = ['content-type', 'cache-control', 'etag', 'content-disposition', 'content-range', 'accept-ranges', 'last-modified']

// A machine you connected, as web.codinger.app/_remote/machines lists it.
// name: fixed, it goes in /m/<name>/; label: the name the sidebar shows, if you gave one.
export type RemoteMachine = { name: string; label?: string; connected: boolean }

// A machine's name: lower-case letters, digits and dashes (it goes in /m/<name>/).
export const machineName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'machine'
