// Web Push from the hub, with WebCrypto only: the VAPID key that says the hub sent a push
// (RFC 8292), and the payload encrypted for one browser (RFC 8291, aes128gcm).

// The hub's VAPID key pair: the public key as the browser takes it (raw P-256, base64url),
// and the private key as a JWK.
export type Vapid = { pub: string; priv: JsonWebKey }
// A browser's subscription, as PushSubscription.toJSON() gives it.
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } }

const enc = new TextEncoder()

export async function newVapid(): Promise<Vapid> {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey) as ArrayBuffer)
  return { pub: b64u(pub), priv: await crypto.subtle.exportKey('jwk', k.privateKey) as JsonWebKey }
}

// Send one push. The status is the push service's: 201 sent, 404 or 410 the subscription is gone.
export async function sendPush(sub: Subscription, payload: string, vapid: Vapid, contact: string, ttl = 24 * 3600): Promise<number> {
  const body = await encrypt(sub, enc.encode(payload))
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: `vapid t=${await jwt(new URL(sub.endpoint).origin, vapid, contact)}, k=${vapid.pub}`,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency: 'high',
    },
    body,
  })
  return res.status
}

async function jwt(aud: string, vapid: Vapid, contact: string) {
  const key = await crypto.subtle.importKey('jwk', vapid.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact })))
  // WebCrypto signs ECDSA as r || s, the form a JWS takes.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)))
  return `${head}.${claims}.${b64u(sig)}`
}

// RFC 8291: one record, with a key of our own for this message only.
export async function encrypt(sub: Subscription, data: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPub = unb64u(sub.keys.p256dh)
  const auth = unb64u(sub.keys.auth)
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey) as ArrayBuffer)
  const ua = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  // The Workers types call `public` `$public`; the runtime takes `public`, as the standard does.
  const ecdh = { name: 'ECDH', public: ua } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0]
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, as.privateKey, 256))
  const ikm = await hkdf(auth, secret, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // 0x02: the last record, with no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))))
  // The header: the salt, the record size, and our public key as the key id.
  const head = new Uint8Array(16 + 4 + 1 + asPub.length)
  head.set(salt)
  new DataView(head.buffer).setUint32(16, 4096)
  head[20] = asPub.length
  head.set(asPub, 21)
  return concat(head, sealed)
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8))
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}

export function b64u(b: Uint8Array) {
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64u(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
