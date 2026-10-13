// Esc closes the dialog on top, wherever the focus is, the way its X does.
// Each open dialog registers its close; the last one opened goes first. A key
// something inside already used (a field's own Esc) is left alone.

import { useEffect, useRef } from 'react'

const stack: (() => void)[] = []
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !stack.length) return
  e.preventDefault()
  stack.at(-1)!()
})

export function useEscape(close: () => void) {
  const ref = useRef(close)
  ref.current = close
  useEffect(() => {
    const f = () => ref.current()
    stack.push(f)
    return () => { stack.splice(stack.indexOf(f), 1) }
  }, [])
}
