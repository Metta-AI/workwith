// What a session's critter can wear. Each Claude picks its own with the
// set_look tool (server/index.ts); the drawings are in web/src/components/looks.tsx.

export const LOOK_OPTIONS = {
  color: ['classic', 'ocean', 'moss', 'grape', 'bubblegum', 'slate', 'gold', 'midnight'],
  hat: ['top-hat', 'beanie', 'cap', 'cowboy', 'wizard', 'crown', 'party', 'beret', 'fez', 'chef', 'viking', 'propeller', 'headphones', 'halo', 'flower', 'bow', 'antenna', 'pirate', 'bucket', 'hard-hat', 'graduation', 'santa'],
  hair: ['spiky', 'mohawk', 'quiff', 'curly', 'long', 'bun', 'pigtails', 'afro', 'side-part', 'fringe'],
  eyewear: ['round-glasses', 'square-glasses', 'cat-eye-glasses', 'shades', 'monocle', 'eyepatch', '3d-glasses', 'goggles'],
  face: ['moustache', 'handlebar', 'beard', 'goatee', 'blush', 'freckles', 'smile', 'grin', 'fangs'],
  neck: ['bowtie', 'tie', 'scarf', 'gold-chain', 'bandana', 'lei', 'name-badge', 'cape'],
  held: ['coffee', 'wand', 'balloon', 'flower', 'lightsaber', 'pencil', 'flag', 'umbrella'],
} as const

export type LookSlot = keyof typeof LOOK_OPTIONS
export type Look = { [S in LookSlot]?: (typeof LOOK_OPTIONS)[S][number] }
export const LOOK_SLOTS = Object.keys(LOOK_OPTIONS) as LookSlot[]

// Keep only known slots and options; "none" (or empty) clears a slot.
export function cleanLook(input: Record<string, unknown>, base: Look = {}): { look: Look; rejected: string[] } {
  const look: Record<string, string> = { ...base }
  const rejected: string[] = []
  for (const [slot, v] of Object.entries(input)) {
    if (!(slot in LOOK_OPTIONS)) { rejected.push(slot); continue }
    if (v == null || v === '' || v === 'none') { delete look[slot]; continue }
    if ((LOOK_OPTIONS[slot as LookSlot] as readonly string[]).includes(String(v))) look[slot] = String(v)
    else rejected.push(`${slot}=${v}`)
  }
  return { look: look as Look, rejected }
}

export const describeLook = (l: Look) => LOOK_SLOTS.filter((s) => l[s]).map((s) => `${s} ${l[s]}`).join(', ')
