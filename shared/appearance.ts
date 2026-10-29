// How Codinger looks: light or dark, an accent colour, the tone of its surfaces,
// the font and its size, and whether critters move. Kept in the server's
// settings, so every browser shares it; web/src/appearance.ts applies it,
// styles.css holds the colours.

export const THEMES = ['system', 'light', 'dark'] as const
// The critters' colours (shared/looks.ts), so an accent has a critter to match,
// and 'custom' for any colour you pick.
export const ACCENTS = ['teal', 'ocean', 'midnight', 'grape', 'bubblegum', 'tangerine', 'gold', 'moss', 'slate', 'custom'] as const
// 'black' is for dark mode on OLED screens; in light mode it is 'neutral'.
export const SURFACES = ['warm', 'neutral', 'cool', 'black'] as const
export const FONTS = ['system', 'rounded', 'serif', 'hyperlegible', 'dyslexic'] as const
// How big the conversation's text is, against the usual 14px.
export const TEXT_SIZES = { small: 0.93, medium: 1, large: 1.1, larger: 1.22 } as const

export type Appearance = {
  theme: (typeof THEMES)[number]
  accent: (typeof ACCENTS)[number]
  custom?: string           // #rrggbb, for the 'custom' accent
  surface: (typeof SURFACES)[number]
  font?: (typeof FONTS)[number]
  textSize?: keyof typeof TEXT_SIZES
  compact?: boolean         // one-line rows in the sidebar
  calm?: boolean            // critters keep still
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', accent: 'teal', surface: 'warm' }

const pick = <T extends readonly string[]>(list: T, v: unknown, d: T[number]): T[number] => list.includes(v as string) ? v as T[number] : d

export function cleanAppearance(x: unknown): Appearance {
  const a = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
  const custom = typeof a.custom === 'string' && /^#[0-9a-f]{6}$/i.test(a.custom) ? a.custom.toLowerCase() : undefined
  const accent = pick(ACCENTS, a.accent, DEFAULT_APPEARANCE.accent)
  const font = pick(FONTS, a.font, 'system')
  const textSize = pick(Object.keys(TEXT_SIZES) as (keyof typeof TEXT_SIZES)[], a.textSize, 'medium')
  return {
    theme: pick(THEMES, a.theme, DEFAULT_APPEARANCE.theme),
    accent: accent === 'custom' && !custom ? DEFAULT_APPEARANCE.accent : accent,
    ...(custom ? { custom } : {}),
    surface: pick(SURFACES, a.surface, DEFAULT_APPEARANCE.surface),
    ...(font !== 'system' ? { font } : {}),
    ...(textSize !== 'medium' ? { textSize } : {}),
    ...(a.compact === true ? { compact: true } : {}),
    ...(a.calm === true ? { calm: true } : {}),
  }
}

// Dark text or white on a fill of this colour, whichever reads better.
export function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? '#1d1c1a' : '#ffffff'
}
