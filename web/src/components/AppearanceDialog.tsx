// Light or dark, an accent (or a colour of your own), the tone of the surfaces,
// the font and its size. The first load opens this as a welcome; Settings
// shows the same picks in a tab. Each pick shows at once and is saved.

import { useEffect } from 'react'
import { useEscape } from '../escape.ts'
import { ACCENTS, DEFAULT_APPEARANCE, FONTS, SURFACES, TEXT_SIZES, THEMES, type Appearance } from '../../../shared/appearance.ts'
import { api, changed, state, useStore } from '../store.ts'
import { applyAppearance, holdAppearance, loadFonts } from '../appearance.ts'
import { Mascot } from './Mascot.tsx'
import { XIcon } from './Icons.tsx'

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const SURFACE_NOTE: Record<string, [string, string?]> = { warm: ['Paper'], neutral: ['Grey'], cool: ['Blue-grey'], black: ['Black', 'Pure black in dark mode (for OLED); grey in light mode'] }
const THEME_NOTE = { system: 'Follows your computer', light: '', dark: '' }
const FONT_NOTE: Record<string, [string, string]> = {
  system: ['System', "Your computer's font"],
  rounded: ['Rounded', 'Softer letter shapes'],
  serif: ['Serif', 'Like a printed page'],
  hyperlegible: ['Hyperlegible', 'Atkinson Hyperlegible: clear letters for low vision'],
  dyslexic: ['OpenDyslexic', 'Weighted letters that can help readers with dyslexia'],
}
const SIZE_NOTE = { small: 'S', medium: 'M', large: 'L', larger: 'XL' }

// From the store, not a render: picks made before it redraws all count.
let saving: ReturnType<typeof setTimeout> | undefined
function setAppearance(patch: Partial<Appearance>) {
  const next = { ...(state.settings.appearance ?? DEFAULT_APPEARANCE), ...patch }
  state.settings = { ...state.settings, appearance: next }
  changed()
  applyAppearance(next)
  // The colour picker reports every step of a drag: save once it rests.
  holdAppearance()
  clearTimeout(saving)
  saving = setTimeout(() => void api('/api/settings', 'PUT', { appearance: next }), 250)
}

export function AppearanceDialog({ welcome, onClose }: { welcome?: boolean; onClose(): void }) {
  // Closing the welcome keeps the default, so it does not ask again.
  const close = () => { if (!state.settings.appearance) setAppearance({}); onClose() }
  useEscape(close)

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="modal appearance-modal">
        <div className="appearance-head">
          <h2>{welcome ? 'Welcome to Codinger' : 'Appearance'}</h2>
          <button className="icon-btn" title="Close" onClick={close}><XIcon size={14} /></button>
        </div>
        {welcome && <p className="muted appearance-lead">Pick a colour to make it yours. You can change this later in Settings.</p>}
        <AppearancePanel />
        <div className="modal-actions">
          <button className="primary" onClick={close}>{welcome ? 'Start' : 'Done'}</button>
        </div>
      </div>
    </div>
  )
}

// The picks themselves: in the welcome above, and in a tab of Settings.
export function AppearancePanel() {
  const st = useStore()
  const a = st.settings.appearance ?? DEFAULT_APPEARANCE
  const set = setAppearance
  useEffect(loadFonts, [])
  const custom = a.custom ?? '#d94f8a'

  return (
    <div className="appearance-panel">
      <div className="swatches">
        {ACCENTS.filter((c) => c !== 'custom').map((c) => (
          <button key={c} className={`swatch${a.accent === c ? ' on' : ''}`} onClick={() => set({ accent: c })} title={cap(c)}>
            <Mascot status="idle" fatigue={0} look={{ color: c, ...(a.accent === c ? { hat: 'party' } : {}) }} size={38} />
            <span>{cap(c)}</span>
          </button>
        ))}
        {/* Any colour: the swatch is a colour input under a critter of that colour. */}
        <label className={`swatch${a.accent === 'custom' ? ' on' : ''}`} title="Custom colour">
          <input type="color" value={custom} onClick={() => { if (a.accent !== 'custom') set({ accent: 'custom', custom }) }}
            onChange={(e) => set({ accent: 'custom', custom: e.target.value })} />
          <Mascot status="idle" fatigue={0} body={custom} look={a.accent === 'custom' ? { hat: 'party' } : {}} size={38} />
          <span>{a.accent === 'custom' ? custom : 'Your own'}</span>
        </label>
      </div>
      <div className="appearance-row">
        <span className="appearance-label">Mode</span>
        <div className="seg">
          {THEMES.map((t) => <button key={t} className={a.theme === t ? 'on' : ''} title={THEME_NOTE[t]} onClick={() => set({ theme: t })}>{cap(t)}</button>)}
        </div>
      </div>
      <div className="appearance-row">
        <span className="appearance-label">Surfaces</span>
        <div className="seg">
          {SURFACES.map((s) => (
            <button key={s} className={a.surface === s ? 'on' : ''} title={SURFACE_NOTE[s][1]} onClick={() => set({ surface: s })}>
              <span className={`tone tone-${s}`} />{SURFACE_NOTE[s][0]}
            </button>
          ))}
        </div>
      </div>
      <div className="appearance-row">
        <span className="appearance-label">Font</span>
        <div className="seg wrap">
          {FONTS.map((f) => <button key={f} className={`font-${f}${(a.font ?? 'system') === f ? ' on' : ''}`} title={FONT_NOTE[f][1]} onClick={() => set({ font: f })}>{FONT_NOTE[f][0]}</button>)}
        </div>
      </div>
      <div className="appearance-row">
        <span className="appearance-label">Text size</span>
        <div className="seg">
          {(Object.keys(TEXT_SIZES) as (keyof typeof TEXT_SIZES)[]).map((z) => (
            <button key={z} className={(a.textSize ?? 'medium') === z ? 'on' : ''} title={`${cap(z)} conversation text`} style={{ fontSize: `${13 * TEXT_SIZES[z]}px` }} onClick={() => set({ textSize: z })}>{SIZE_NOTE[z]}</button>
          ))}
        </div>
      </div>
      <div className="appearance-checks">
        <label className="settings-check">
          <input type="checkbox" checked={!!a.compact} onChange={(e) => set({ compact: e.target.checked })} />
          Compact sidebar
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={!!a.calm} onChange={(e) => set({ calm: e.target.checked })} />
          Critters keep still
        </label>
      </div>
    </div>
  )
}
