// Puts the appearance (shared/appearance.ts) on <html> for styles.css to read.
// A copy kept in localStorage lets index.html apply it before the page draws.

import { TEXT_SIZES, cleanAppearance, inkOn, type Appearance } from '../../shared/appearance.ts'
import { BODY_COLORS } from './components/looks.tsx'

// The bundled fonts load only when picked.
const FONT_FILES: Record<string, () => Promise<unknown>> = {
  hyperlegible: () => Promise.all([import('@fontsource/atkinson-hyperlegible/400.css'), import('@fontsource/atkinson-hyperlegible/700.css')]),
  dyslexic: () => Promise.all([import('@fontsource/opendyslexic/400.css'), import('@fontsource/opendyslexic/700.css')]),
}

// So their buttons can show them before you pick one.
export const loadFonts = () => { for (const f of Object.values(FONT_FILES)) void f() }

export function applyAppearance(a: Appearance | undefined) {
  const x = cleanAppearance(a)
  const root = document.documentElement
  if (x.theme === 'system') delete root.dataset.theme
  else root.dataset.theme = x.theme
  root.dataset.accent = x.accent
  root.dataset.surface = x.surface
  root.dataset.font = x.font ?? 'system'
  void FONT_FILES[x.font ?? '']?.()
  root.style.setProperty('--read-scale', String(TEXT_SIZES[x.textSize ?? 'medium']))
  // A colour of your own: as picked in light mode, a little lighter in dark.
  if (x.accent === 'custom' && x.custom) {
    root.style.setProperty('--accent', `light-dark(${x.custom}, color-mix(in srgb, ${x.custom} 80%, white))`)
    root.style.setProperty('--on-accent', inkOn(x.custom))
  } else {
    root.style.removeProperty('--accent')
    root.style.removeProperty('--on-accent')
  }
  root.classList.toggle('calm', !!x.calm)
  root.classList.toggle('compact-side', !!x.compact)
  if (a) localStorage.setItem('codiner.appearance', JSON.stringify(x))
}

// The accent's colour as a critter's body.
export const accentBody = (a: Appearance | undefined) => {
  const x = cleanAppearance(a)
  return x.accent === 'custom' ? x.custom! : BODY_COLORS[x.accent]
}

// For a moment after a pick here, the server's echo of an older pick does not undo it.
let hold = 0
export const holdAppearance = () => { hold = Date.now() + 2000 }
export const holdingAppearance = () => Date.now() < hold
