// Pixel drawings for the critter's accessories (shared/looks.ts lists them).
// The critter's grid is 18 wide; its body is x 2–13, y 3–9, its eyes at x 5 and
// 10, y 4–5, its arms at x 0–1 and 14–15, y 5–6, and its legs at y 10–11. Hats
// and hair use the rows above it (down to y -6), held things the columns 16–17.

import type { LookSlot } from '../../../shared/looks.ts'
import { LOOK_OPTIONS } from '../../../shared/looks.ts'

// [x, y, width, height, fill]
type Px = [number, number, number, number, string]
// back: drawn behind the body (a cape); spin: a part that turns (propeller blades).
type Drawing = Px[] | { back?: Px[]; front: Px[]; spin?: Px[] }
type Drawings = { [S in Exclude<LookSlot, 'color'>]: Record<(typeof LOOK_OPTIONS)[S][number], Drawing> }

export const BODY_COLORS: Record<(typeof LOOK_OPTIONS)['color'][number], string> = {
  classic: '#D97757', ocean: '#3f8fd6', moss: '#5e9e4f', grape: '#8a5cc7', bubblegum: '#e57aa8', slate: '#7d8a99', gold: '#d9a521', midnight: '#3b4a7a',
}

const K = '#222', BROWN = '#3a2a1f', RED = '#e5534b', BLUE = '#4c8dff', YELLOW = '#ffd54a', GREEN = '#3fb950', PINK = '#ff6fae', WHITE = '#ffffff', GOLD = '#f2c230'

export const DRAWINGS: Drawings = {
  hat: {
    'top-hat': [[1, 2, 14, 1, K], [4, -3, 8, 5, K], [4, 0, 8, 1, '#c0392b']],
    beanie: [[3, 0, 10, 2, '#3b6fd8'], [2, 2, 12, 1, '#2c56b0'], [7, -2, 2, 2, WHITE]],
    cap: [[3, 0, 9, 3, RED], [11, 2, 5, 1, '#b83b34'], [7, -1, 1, 1, '#b83b34']],
    cowboy: [[0, 2, 16, 1, '#8b5a2b'], [0, 1, 1, 1, '#8b5a2b'], [15, 1, 1, 1, '#8b5a2b'], [4, -1, 8, 3, '#a0522d'], [4, 1, 8, 1, '#5c3317'], [7, -1, 2, 1, '#8b5a2b']],
    wizard: [[7, -6, 2, 1, '#6c4bd1'], [6, -5, 4, 2, '#6c4bd1'], [5, -3, 6, 2, '#6c4bd1'], [4, -1, 8, 3, '#6c4bd1'], [2, 2, 12, 1, '#5a3cb8'], [6, -2, 1, 1, YELLOW], [9, 0, 1, 1, YELLOW]],
    crown: [[3, 1, 10, 2, GOLD], [3, -1, 2, 2, GOLD], [7, -2, 2, 3, GOLD], [11, -1, 2, 2, GOLD], [5, 1, 1, 1, RED], [7, 1, 2, 1, BLUE], [10, 1, 1, 1, GREEN]],
    party: [[7, -5, 2, 1, YELLOW], [7, -4, 2, 1, PINK], [6, -3, 4, 2, PINK], [5, -1, 6, 2, PINK], [4, 1, 8, 2, PINK], [6, -2, 4, 1, YELLOW], [4, 1, 8, 1, YELLOW]],
    beret: [[2, 1, 12, 2, '#c0392b'], [4, 0, 9, 1, '#c0392b'], [8, -1, 1, 1, '#c0392b']],
    fez: [[5, -1, 6, 4, '#b03a2e'], [5, -1, 6, 1, '#c0392b'], [10, -1, 1, 1, K], [11, 0, 1, 2, K]],
    chef: [[4, -5, 8, 2, WHITE], [3, -4, 10, 3, WHITE], [4, -1, 8, 4, '#f4f4f4'], [3, -4, 1, 3, '#d8d8d8'], [12, -4, 1, 3, '#d8d8d8'], [4, 2, 8, 1, '#d8d8d8']],
    viking: [[5, -1, 6, 1, '#9aa3ad'], [4, 0, 8, 2, '#9aa3ad'], [3, 2, 10, 1, '#6b737c'], [2, 0, 1, 2, '#f1e6c8'], [1, -2, 1, 2, '#f1e6c8'], [13, 0, 1, 2, '#f1e6c8'], [14, -2, 1, 2, '#f1e6c8']],
    propeller: {
      front: [[4, 0, 4, 3, RED], [8, 0, 4, 3, BLUE], [3, 2, 10, 1, YELLOW], [7, -1, 2, 1, '#666']],
      spin: [[3, -2, 5, 1, GREEN], [8, -2, 5, 1, YELLOW]],
    },
    headphones: [[2, -1, 12, 1, '#333'], [1, 0, 1, 2, '#333'], [14, 0, 1, 2, '#333'], [1, 2, 2, 3, RED], [13, 2, 2, 3, RED]],
    halo: [[5, -3, 6, 1, YELLOW], [4, -2, 1, 1, YELLOW], [11, -2, 1, 1, YELLOW], [5, -1, 6, 1, YELLOW]],
    flower: [[7, -1, 1, 1, PINK], [6, 0, 1, 1, PINK], [8, 0, 1, 1, PINK], [7, 1, 1, 1, PINK], [7, 0, 1, 1, YELLOW], [7, 2, 1, 1, GREEN]],
    bow: [[3, 0, 2, 3, PINK], [5, 1, 1, 1, '#d94f8a'], [6, 0, 2, 3, PINK]],
    antenna: [[7, 0, 1, 3, '#333'], [6, -2, 3, 2, GREEN]],
    pirate: [[2, 1, 12, 2, K], [4, -1, 8, 2, K], [6, -2, 4, 1, K], [7, 0, 2, 1, WHITE]],
    bucket: [[4, -1, 8, 3, '#c2b280'], [2, 2, 12, 1, '#a89968']],
    'hard-hat': [[5, -1, 6, 1, '#f5b400'], [4, 0, 8, 2, '#f5b400'], [2, 2, 12, 1, '#d99a00'], [7, -1, 2, 1, '#d99a00']],
    graduation: [[4, -1, 8, 1, K], [1, 0, 14, 1, K], [4, 1, 8, 2, K], [13, 1, 1, 3, YELLOW]],
    santa: [[3, 0, 10, 2, '#d62828'], [5, -1, 6, 1, '#d62828'], [9, -2, 3, 1, '#d62828'], [12, -3, 2, 2, WHITE], [2, 2, 12, 1, WHITE]],
  },
  hair: {
    spiky: [[3, 1, 2, 2, BROWN], [5, 0, 2, 3, BROWN], [7, -1, 2, 4, BROWN], [9, 0, 2, 3, BROWN], [11, 1, 2, 2, BROWN]],
    mohawk: [[7, -2, 2, 5, RED]],
    quiff: [[3, 1, 10, 2, BROWN], [8, -1, 5, 2, BROWN], [13, 0, 1, 1, BROWN]],
    curly: [[2, 1, 12, 2, '#5a3a24'], [3, 0, 3, 1, '#5a3a24'], [7, 0, 3, 1, '#5a3a24'], [11, 0, 2, 1, '#5a3a24'], [4, 1, 1, 1, '#3e271a'], [9, 1, 1, 1, '#3e271a']],
    long: [[2, 1, 12, 2, '#e2b04a'], [1, 2, 1, 3, '#e2b04a'], [14, 2, 1, 3, '#e2b04a'], [2, 3, 2, 1, '#e2b04a'], [12, 3, 2, 1, '#e2b04a']],
    bun: [[3, 2, 10, 1, BROWN], [4, 1, 8, 1, BROWN], [6, -1, 4, 2, BROWN]],
    pigtails: [[3, 2, 10, 1, '#e5a050'], [4, 1, 8, 1, '#e5a050'], [0, 2, 2, 2, '#e5a050'], [14, 2, 2, 2, '#e5a050'], [2, 2, 1, 1, PINK], [13, 2, 1, 1, PINK]],
    afro: [[3, -2, 10, 1, '#2b1d14'], [2, -1, 12, 1, '#2b1d14'], [1, 0, 14, 3, '#2b1d14']],
    'side-part': [[3, 1, 10, 1, '#7a4a2a'], [2, 2, 12, 1, '#7a4a2a'], [10, 3, 3, 1, '#7a4a2a'], [6, 1, 1, 1, '#9c6a46']],
    fringe: [[2, 1, 12, 2, K], [9, 3, 4, 1, K], [11, 4, 2, 1, K]],
  },
  eyewear: {
    'round-glasses': [[4, 3, 3, 1, K], [4, 6, 3, 1, K], [3, 4, 1, 2, K], [7, 4, 1, 2, K], [9, 3, 3, 1, K], [9, 6, 3, 1, K], [8, 4, 1, 2, K], [12, 4, 1, 2, K]],
    'square-glasses': [[3, 3, 5, 1, K], [3, 6, 5, 1, K], [3, 4, 1, 2, K], [7, 4, 1, 2, K], [8, 3, 5, 1, K], [8, 6, 5, 1, K], [8, 4, 1, 2, K], [12, 4, 1, 2, K]],
    'cat-eye-glasses': [[3, 3, 5, 1, '#c2185b'], [4, 6, 3, 1, '#c2185b'], [3, 4, 1, 2, '#c2185b'], [7, 4, 1, 2, '#c2185b'], [8, 3, 5, 1, '#c2185b'], [9, 6, 3, 1, '#c2185b'], [8, 4, 1, 2, '#c2185b'], [12, 4, 1, 2, '#c2185b'], [2, 2, 1, 1, '#c2185b'], [13, 2, 1, 1, '#c2185b']],
    shades: [[3, 4, 10, 2, '#111'], [2, 4, 1, 1, '#111'], [13, 4, 1, 1, '#111'], [4, 4, 1, 1, '#555'], [9, 4, 1, 1, '#555']],
    monocle: [[9, 3, 3, 1, '#c9a227'], [9, 6, 3, 1, '#c9a227'], [8, 4, 1, 2, '#c9a227'], [12, 4, 1, 2, '#c9a227'], [12, 7, 1, 2, '#c9a227']],
    eyepatch: [[4, 4, 3, 2, '#111'], [2, 4, 2, 1, '#111'], [7, 3, 7, 1, '#111']],
    '3d-glasses': [[3, 3, 10, 1, WHITE], [4, 4, 3, 2, RED], [9, 4, 3, 2, BLUE], [3, 4, 1, 2, WHITE], [7, 4, 2, 1, WHITE], [12, 4, 1, 2, WHITE]],
    goggles: [[2, 4, 12, 1, '#7a4a2a'], [4, 3, 3, 3, '#9fd8ff'], [9, 3, 3, 3, '#9fd8ff'], [5, 4, 1, 1, '#3a6e8f'], [10, 4, 1, 1, '#3a6e8f']],
  },
  face: {
    moustache: [[5, 7, 6, 1, BROWN]],
    handlebar: [[5, 7, 6, 1, BROWN], [4, 7, 1, 1, BROWN], [11, 7, 1, 1, BROWN], [3, 6, 1, 1, BROWN], [12, 6, 1, 1, BROWN]],
    beard: [[2, 7, 12, 3, '#5a3a24'], [6, 10, 4, 1, '#5a3a24'], [6, 7, 4, 1, '#3e271a']],
    goatee: [[6, 7, 4, 1, BROWN], [7, 8, 2, 2, BROWN]],
    blush: [[3, 6, 2, 1, '#ff9a9a'], [11, 6, 2, 1, '#ff9a9a']],
    freckles: [[4, 6, 1, 1, '#a5523a'], [6, 7, 1, 1, '#a5523a'], [9, 7, 1, 1, '#a5523a'], [11, 6, 1, 1, '#a5523a']],
    smile: [[6, 7, 1, 1, '#2a1f1a'], [7, 8, 2, 1, '#2a1f1a'], [9, 7, 1, 1, '#2a1f1a']],
    grin: [[6, 7, 4, 1, '#2a1f1a'], [7, 8, 2, 1, RED]],
    fangs: [[6, 7, 4, 1, '#2a1f1a'], [6, 8, 1, 1, WHITE], [9, 8, 1, 1, WHITE]],
  },
  neck: {
    bowtie: [[5, 8, 2, 2, RED], [7, 8, 2, 2, '#b83b34'], [9, 8, 2, 2, RED]],
    tie: [[7, 8, 2, 1, '#2c56b0'], [7, 9, 2, 3, '#3b6fd8']],
    scarf: [[2, 8, 12, 2, GREEN], [4, 8, 1, 2, WHITE], [8, 8, 1, 2, WHITE], [11, 10, 2, 2, GREEN]],
    'gold-chain': [[4, 8, 1, 1, GOLD], [5, 9, 6, 1, GOLD], [11, 8, 1, 1, GOLD], [7, 10, 2, 1, GOLD]],
    bandana: [[3, 8, 10, 1, RED], [6, 9, 4, 1, RED], [7, 10, 2, 1, RED], [5, 8, 1, 1, WHITE], [10, 8, 1, 1, WHITE]],
    lei: [[3, 8, 2, 1, PINK], [5, 9, 2, 1, YELLOW], [7, 9, 2, 1, PINK], [9, 9, 2, 1, YELLOW], [11, 8, 2, 1, PINK]],
    'name-badge': [[10, 7, 3, 2, WHITE], [10, 7, 3, 1, BLUE]],
    cape: { back: [[1, 3, 14, 9, '#c0392b']], front: [] },
  },
  held: {
    coffee: [[16, 4, 2, 3, BLUE], [16, 2, 1, 1, '#c8c8c8'], [17, 1, 1, 1, '#c8c8c8']],
    wand: [[16, 5, 1, 1, '#5c3317'], [17, 4, 1, 1, '#5c3317'], [17, 2, 1, 1, YELLOW], [16, 1, 1, 1, YELLOW]],
    balloon: [[15, -3, 3, 3, RED], [16, 0, 1, 5, '#999']],
    flower: [[16, 3, 1, 3, GREEN], [15, 1, 3, 2, PINK], [16, 1, 1, 1, YELLOW]],
    lightsaber: [[16, -2, 1, 6, '#7fe3ff'], [16, 4, 1, 2, '#555']],
    pencil: [[16, 1, 1, 1, '#ff9a9a'], [16, 2, 1, 4, '#f5b400'], [16, 6, 1, 1, '#333']],
    flag: [[16, -1, 1, 8, '#666'], [17, -1, 1, 2, RED]],
    umbrella: [[14, -2, 4, 1, BLUE], [15, -3, 2, 1, BLUE], [16, -1, 1, 6, '#333']],
  },
}

export function partsOf(d: Drawing | undefined): { back: Px[]; front: Px[]; spin: Px[] } {
  if (!d) return { back: [], front: [], spin: [] }
  return Array.isArray(d) ? { back: [], front: d, spin: [] } : { back: d.back ?? [], front: d.front, spin: d.spin ?? [] }
}

export const rects = (px: Px[], key: string) => px.map(([x, y, w, h, fill], i) => <rect key={`${key}${i}`} x={x} y={y} width={w} height={h} fill={fill} />)
