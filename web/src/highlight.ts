// Syntax highlighting for commands, files Claude writes or edits, and fenced
// code in messages. Only the common languages are bundled.

import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

for (const [name, lang] of Object.entries({ bash, css, diff, go, javascript, json, markdown, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, lang)
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['tsx', 'ts'], { languageName: 'typescript' })
hljs.registerAliases(['jsx', 'js', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['rs'], { languageName: 'rust' })

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// HTML for `code` in `lang` (a name, alias or file extension); plain, escaped, if unknown.
export function highlight(code: string, lang: string | undefined): string {
  const l = lang?.toLowerCase()
  if (!l || !hljs.getLanguage(l)) return escape(code)
  try { return hljs.highlight(code, { language: l, ignoreIllegals: true }).value } catch { return escape(code) }
}

export const langOfPath = (p: string | undefined) => p?.split(/[\\/]/).pop()?.split('.').slice(1).pop()
