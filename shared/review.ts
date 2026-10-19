// Your decision on the agent's changes (the For review section of the Files tab, web/src/review.ts):
// approve or reject each file of a group (the files the agent changed in one turn), and comments
// on lines, each with approve, reject or unsure. They go to the agent as one part of a message.

export type Verdict = 'approve' | 'reject'
export type LineVerdict = Verdict | 'unsure'

// group: the seq of the message that started the turn; path: the file's absolute path; rel: the
// path the agent gets (relative to the session's folder when it is in it).
export type FileVerdict = { group: string; path: string; rel: string; verdict: Verdict }
// line to end: lines of the file after the change; old: lines that the change removed (their
// numbers before it). code: the first of the lines, for context.
export type LineComment = { group?: string; path: string; rel: string; line: number; end: number; old?: boolean; code: string; verdict: LineVerdict; text: string }

const WORD: Record<LineVerdict, string> = { approve: 'approve', reject: 'reject', unsure: 'unsure' }

// The text the agent receives.
export function formatReview(files: FileVerdict[], comments: LineComment[]): string {
  const out = ['**Review of your changes:**']
  const list = (v: Verdict) => [...new Set(files.filter((f) => f.verdict === v).map((f) => `\`${f.rel}\``))].join(', ')
  if (files.some((f) => f.verdict === 'approve')) out.push(`- Approved: ${list('approve')}`)
  if (files.some((f) => f.verdict === 'reject')) out.push(`- Rejected: ${list('reject')}`)
  if (comments.length) {
    out.push('- Comments on lines:')
    for (const c of comments) {
      const at = `${c.rel}:${c.line}${c.end > c.line ? `-${c.end}` : ''}`
      const code = c.code.trim().slice(0, 120)
      const on = [WORD[c.verdict], c.old ? (c.end > c.line ? 'removed lines' : 'removed line') : '', code ? `on \`${code.replace(/`/g, "'")}\`` : ''].filter(Boolean).join(', ')
      out.push(`  - \`${at}\` (${on}): ${c.text.trim().replace(/\n+/g, ' ')}`)
    }
  }
  return out.join('\n')
}
