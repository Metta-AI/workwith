// A person as a small round badge: their initial, in a colour of their own (from the
// login, so it is the same on every screen).
import type { Person } from '../../../shared/types.ts'

export function hueOf(login: string): number {
  let h = 0
  for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 360
}

export function Who({ p, size = 16 }: { p: Person | null | undefined; size?: number }) {
  const name = p?.name ?? 'Someone'
  return (
    <span className="who-badge" title={name}
      style={{ width: size, height: size, fontSize: size * 0.62, background: `hsl(${hueOf(p?.login ?? name)} 55% 45%)` }}>
      {name.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  )
}
