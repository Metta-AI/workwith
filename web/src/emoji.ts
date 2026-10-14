// Emoji for reactions: the ones you use most come first, and the full list
// (names from unicode-emoji-json) loads only when you search it.

const KEY = 'codinger.emoji'
const DEFAULT = ['👍', '❤️', '🎉', '💪', '😂', '🤔', '🙏', '👀', '🔥', '🙌']

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

// words: what a search matches besides the name (emojilib's keywords, plus a few of ours).
export type EmojiInfo = { emoji: string; name: string; group: string; words: string[] }
const EXTRA: Record<string, string[]> = { '🫨': ['omg', 'wow', 'whoa'], '🤯': ['omg', 'wow'], '😮': ['omg', 'wow'], '🥳': ['yay', 'woohoo'], '🫶': ['love', 'thanks'], '🫡': ['ok', 'on it', 'yes sir'] }
let all: Promise<EmojiInfo[]> | null = null
export function allEmoji(): Promise<EmojiInfo[]> {
  all ??= Promise.all([import('unicode-emoji-json/data-by-emoji.json'), import('emojilib/dist/emoji-en-US.json')]).then(([m, k]) => {
    const kw = k.default as Record<string, string[]>
    return Object.entries(m.default as Record<string, { name: string; group: string }>).map(([emoji, v]) => ({
      emoji, name: v.name, group: v.group,
      words: [...(kw[emoji] ?? []), ...(EXTRA[emoji] ?? [])].map((w) => w.toLowerCase().replace(/_/g, ' ')),
    }))
  })
  return all
}

// Search by name and keywords, every word must match; exact keyword hits come first.
export function searchEmoji(list: EmojiInfo[], q: string): EmojiInfo[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const score = (e: EmojiInfo) => {
    let s = 0
    for (const w of words) {
      if (e.words.includes(w) || e.name === w) s += 3
      else if (e.name.split(' ').some((n) => n.startsWith(w)) || e.words.some((k) => k.startsWith(w))) s += 2
      else if (e.name.includes(w) || e.words.some((k) => k.includes(w))) s += 1
      else return 0
    }
    return s
  }
  return list.map((e) => [e, score(e)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([e]) => e)
}

// A comment that is only emoji is a reaction.
export const isReaction = (text: string) => !!text.trim() && /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u.test(text.trim()) && !/^[\d#*\s]+$/.test(text.trim())
