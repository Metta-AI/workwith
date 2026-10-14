// Defaults for rolling notes and keep-warm (server/notes.ts), shared with Settings.

export const KEEP_WARM = {
  hours: 6,          // keep a quiet session's cache warm this long; 0 turns keep-warm off
  max: 500_000,      // past this many tokens of context, suggest a new session from the notes
  usage: 80,         // not when a call would take your 5-hour usage past this percentage
}

export const notesFile = (id: string) => `.codinger/notes/${id}.md`
