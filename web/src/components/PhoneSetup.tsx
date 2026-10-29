// On a phone, a banner for what it takes to get notifications: on an iPhone in Safari, Add to
// Home Screen first (Safari has web push only for a web app on the Home Screen); then the
// notifications themselves. Later hides it for a week on this phone.

import { useEffect, useState } from 'react'
import { useStore } from '../store.ts'
import { enablePush, pushSubscribed, pushSupported } from '../push.ts'

const KEY = 'codinger.phoneSetupLater'
const WEEK = 7 * 86400_000
const touch = () => matchMedia('(pointer: coarse)').matches
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

export function PhoneSetup() {
  const st = useStore()
  const [later, setLater] = useState(() => Date.now() - Number(localStorage.getItem(KEY) ?? 0) < WEEK)
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Settings can turn notifications on too: look again when it closes and when the page shows again.
  useEffect(() => {
    const look = () => void pushSubscribed().then(setOn)
    look()
    document.addEventListener('visibilitychange', look)
    return () => document.removeEventListener('visibilitychange', look)
  }, [st.settingsPage])
  if (later || !touch()) return null
  const hide = () => { localStorage.setItem(KEY, String(Date.now())); setLater(true) }
  if (ios() && !standalone()) return (
    <div className="signin restart">
      <span>Add Codinger to your Home Screen to get notifications on this phone: tap Share, then Add to Home Screen, then open Codinger from there.</span>
      <span className="banner-btns"><button onClick={hide}>Later</button></span>
    </div>
  )
  if (on !== false || !pushSupported() || Notification.permission === 'denied' || !(st.web || st.self)) return null
  const turnOn = async () => {
    setBusy(true); setErr(null)
    try { await enablePush(); setOn(true) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="signin restart">
      <span>{err ?? 'Turn on notifications, so a session can tell you when it finishes or asks you something.'}</span>
      <span className="banner-btns">
        <button onClick={hide}>Later</button>
        <button className="primary" disabled={busy} onClick={() => void turnOn()}>Turn on</button>
      </span>
    </div>
  )
}
