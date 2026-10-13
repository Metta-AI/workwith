// Emoji for reactions: the ones you use most come first, and the full list
// (names from unicode-emoji-json) loads only when you search it.

const KEY = 'codiner.emoji'
const DEFAULT = ['👍', '❤️', '🎉', '💪', '😂', '🤔', '🙏', '👀']

const counts: Record<string, number> = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} } })()

export function usedEmoji(e: string) {
  counts[e] = (counts[e] ?? 0) + 1
  localStorage.setItem(KEY, JSON.stringify(counts))
  localStorage.setItem(`${KEY}.last`, e)
}

// What a quick click on the reaction button puts on: the one you used last.
export const lastEmoji = () => localStorage.getItem(`${KEY}.last`) ?? '👍'

// The n most used, topped up from the defaults; 👍 stays first until something beats it.
export function topEmoji(n = 6): string[] {
  const used = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || DEFAULT.indexOf(a) - DEFAULT.indexOf(b))
  return [...new Set([...used, ...DEFAULT])].slice(0, n)
}

export type EmojiInfo = { emoji: string; name: string; group: string }
let all: Promise<EmojiInfo[]> | null = null
export function allEmoji(): Promise<EmojiInfo[]> {
  all ??= import('unicode-emoji-json/data-by-emoji.json').then((m) =>
    Object.entries(m.default as Record<string, { name: string; group: string }>).map(([emoji, v]) => ({ emoji, name: v.name, group: v.group })))
  return all
}

// A comment that is only emoji is a reaction.
export const isReaction = (text: string) => !!text.trim() && /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u.test(text.trim()) && !/^[\d#*\s]+$/.test(text.trim())
