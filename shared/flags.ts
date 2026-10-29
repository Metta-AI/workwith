// Extra Claude Code flags a session starts with (SessionMeta.flags): each one a flag and,
// for some, its value, as typed ("--chrome", "--effort high", "--add-dir ~/notes").

export type FlagOption = {
  flag: string
  value?: string        // the value this option sets (one option for each --effort level)
  needs?: string        // the flag takes a value you type: what it is
  help: string
}

// The flags New session offers. Any other flag can be typed in, except the ones Codinger sets itself.
export const FLAG_OPTIONS: FlagOption[] = [
  { flag: '--chrome', help: 'Claude in Chrome: the agent drives your Chrome' },
  { flag: '--ide', help: 'Connect to your IDE on startup' },
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ flag: '--effort', value, help: `Effort level: ${value}` })),
  { flag: '--add-dir', needs: 'directory', help: 'Let tools use another directory too' },
  { flag: '--agent', needs: 'agent', help: 'Run as one of your agents' },
  { flag: '--fallback-model', needs: 'model', help: 'Model to fall back to when the main one is overloaded' },
  { flag: '--max-budget-usd', needs: 'dollars', help: 'Stop after this much spend on API calls' },
  { flag: '--disallowed-tools', needs: 'tools', help: 'Tools the agent may not use, e.g. "Bash(git push *) WebFetch"' },
  { flag: '--allow-dangerously-skip-permissions', help: 'Let you switch to Bypass permissions later' },
  { flag: '--plugin-dir', needs: 'directory', help: 'Load a plugin from a directory or .zip' },
  { flag: '--settings', needs: 'file or JSON', help: 'Extra settings, from a file or JSON' },
  { flag: '--setting-sources', needs: 'sources', help: 'Which settings to load: user,project,local' },
  { flag: '--autocompact', needs: 'auto or tokens', help: 'Context size at which to compact (100k–1M)' },
  { flag: '--disable-slash-commands', help: 'Turn off all skills' },
  { flag: '--safe-mode', help: 'Start with all customizations off' },
  { flag: '--debug-file', needs: 'path', help: 'Write debug logs to this file' },
]

// Codinger sets these itself, or they don't work in a session it runs.
const RESERVED = new Set([
  '-p', '--print', '--input-format', '--output-format', '--verbose', '--include-partial-messages',
  '--permission-prompt-tool', '--permission-prompts', '-n', '--name', '--permission-mode', '--model',
  '-r', '--resume', '--resume-session-at', '--fork-session', '--session-id', '-c', '--continue',
  '--system-prompt', '--system-prompt-file', '--append-system-prompt', '--append-system-prompt-file',
  '--mcp-config', '--strict-mcp-config', '--allowedTools', '--allowed-tools', '--replay-user-messages',
  '--no-session-persistence', '--bare', '--bg', '--background', '--desktop', '--cloud', '--teleport',
  '--tmux', '-w', '--worktree', '--from-pr', '--remote-control', '--dangerously-skip-permissions',
  '-h', '--help', '-v', '--version', '--json-schema', '--max-turns',
])

// "--effort high" or "--effort=high" → ['--effort', 'high'].
export function splitFlag(s: string): [string, string | null] {
  const t = s.trim()
  const m = /^(-{1,2}[A-Za-z][\w-]*)(?:[=\s]+(.*))?$/s.exec(t)
  // Quotes around the value, as in a shell, go: the process takes it as one argument.
  return m ? [m[1], m[2]?.trim().replace(/^(['"])(.*)\1$/s, '$2') || null] : [t, null]
}

// Why a flag can't be used, or null when it can.
export function flagProblem(s: string): string | null {
  const [flag] = splitFlag(s)
  if (!/^-{1,2}[A-Za-z][\w-]*$/.test(flag)) return `Not a flag: ${s.trim()}`
  if (RESERVED.has(flag)) return `Codinger sets ${flag} itself`
  const known = FLAG_OPTIONS.find((o) => o.flag === flag)
  if (known && (known.needs || known.value) && !splitFlag(s)[1]) return `${flag} needs ${known.needs ? `a ${known.needs}` : 'a value'}`
  return null
}

// The process arguments for a session's flags; home: what a leading ~ in a value stands for.
export function flagArgs(flags: string[] | undefined, home: string): string[] {
  return (flags ?? []).filter((f) => !flagProblem(f)).flatMap((f) => {
    const [flag, value] = splitFlag(f)
    return value == null ? [flag] : [flag, value.replace(/^~(?=$|[/\\])/, home)]
  })
}
