// What kind of machine this is, for its icon in the sidebar: a laptop has a battery.
// Found once at start, in the background (PowerShell takes a second on Windows).

import { execFile } from 'node:child_process'
import fs from 'node:fs'

export type Device = 'laptop' | 'desktop'
let device: Device | undefined

export const deviceType = () => device

export function findDevice(done: (d: Device) => void) {
  const set = (laptop: boolean) => { device = laptop ? 'laptop' : 'desktop'; done(device) }
  if (process.platform === 'darwin') execFile('pmset', ['-g', 'batt'], (_e, out) => set(/InternalBattery/.test(String(out))))
  else if (process.platform === 'win32') execFile('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery | Measure-Object).Count'], { windowsHide: true }, (_e, out) => set(Number(String(out).trim()) > 0))
  else { try { set(fs.readdirSync('/sys/class/power_supply').some((n) => n.startsWith('BAT'))) } catch { set(false) } }
}
