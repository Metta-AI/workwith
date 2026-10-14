// A live copy of a Codinger reply, for the landing page. Each [data-demo] element
// becomes one: select text to comment in the margin, react to a paragraph, answer the
// question, dismiss or finish the item, run the command in a pretend terminal. A small
// demo resets itself a few seconds after you stop using it; the full one (data-full)
// only after you send, and one with data-preset starts marked up and never resets.
// The messages it builds follow shared/asks.ts and shared/blocks.ts in the app.

const IDLE_MS = 9000
const SENT_S = 15
const EMOJI = ['👍', '❤️', '💪', '🙏', '🎉', '🤔']
const COMMENT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'

const RUN_CMD = 'npm test'
const RUN_OUT = [
  '', '> shop@1.0.0 test', '> vitest run', '',
  ' ✓ src/pages/pricing.test.tsx (12 tests) 48ms',
  ' ✓ src/data/plans.test.ts (30 tests) 9ms', '',
  ' Test Files  2 passed (2)', '      Tests  42 passed (42)', '   Duration  1.21s', '',
]

// The reply, split into parts so a demo can show only some of them.
const PARTS = {
  user: `<div class="d-user">Can we ship the pricing page today?</div>`,
  activity: `<div class="d-activity">
    <button class="d-act-sum" data-act="toggle-activity"><span class="d-chev"></span>Thinking · 1 command · 1 edit</button>
    <div class="d-act-items">
      <details class="d-call"><summary><span class="d-ico">✻</span><b>Thinking</b></summary>
        <div class="d-think">The checkout only takes monthly plans. If the page shows the annual price, people will click a button that fails. Leave the annual plan out, build, and run the tests.</div></details>
      <details class="d-call"><summary><span class="d-ico">$</span><b>Bash</b><code class="d-sum">npm run build &amp;&amp; npm test -- --reporter=dot</code></summary>
        <pre class="d-sh" data-sh="npm run build &amp;&amp; npm test -- --reporter=dot"></pre>
        <pre class="d-out">vite v7.1.0 building for production...
✓ 214 modules transformed.
dist/index.html   0.46 kB │ gzip: 0.30 kB
✓ built in 1.84s
··········································
42 passed</pre></details>
      <details class="d-call"><summary><span class="d-ico">✎</span><b>Edit</b><code class="d-sum">src/data/plans.ts</code></summary>
        <div class="d-diff"><pre class="d-del">   { name: 'Team', price: 24, <span class="k">annual</span>: <span class="n">true</span> },</pre><pre class="d-add">   { name: 'Team', price: 24, <span class="k">annual</span>: <span class="n">false</span> },</pre></div></details>
    </div>
  </div>`,
  answer: `<div class="d-answer d-text" data-react>Yes. The page builds and the tests pass. I left the annual plan out, because the checkout cannot take it yet.</div>`,
  para: `<p class="d-text" data-react>The page is at <code>/pricing</code>. It shows three plans side by side, and the table below them compares the features.</p>`,
  consider: `<div class="d-consider" data-key="c1" data-title="The prices on the page are from June">
    <div class="d-con-head"><b class="d-text">The prices on the page are from June</b><button class="d-x" data-act="dismiss" title="Dismiss">✕</button></div>
    <p class="d-text d-con-body" data-react>Sales changed the Team price in August. Check the new figure with them before you publish.</p>
    <div class="d-con-foot"><button data-act="done">✓ Done</button><button data-act="reply">Reply</button></div>
  </div>`,
  ask: `<div class="d-ask" data-id="path" data-q="Where should the page go?">
    <div class="d-con-head"><span class="d-text">Where should the page go?</span><button class="d-x" data-act="dismiss-ask" title="Dismiss">✕</button></div>
    <div class="d-chips"><button data-act="choose">/pricing</button><button data-act="choose">/plans</button></div>
    <input class="d-ask-in" placeholder="Answer">
  </div>`,
  details: `<details class="d-more"><summary>Every file changed</summary><ul class="d-text">
    <li><code>src/pages/pricing.tsx</code>: the new page.</li>
    <li><code>src/data/plans.ts</code>: the three plans and their features.</li>
    <li><code>src/styles/pricing.css</code>: the cards and the table.</li></ul></details>`,
  run: `<div class="d-run" data-key="r1" data-title="Run the tests before you publish">
    <div class="d-run-title">Run the tests before you publish</div>
    <pre class="d-sh" data-sh="${RUN_CMD}"></pre>
    <div class="d-run-actions"><button class="d-primary" data-act="run">›_ Run in Terminal</button><button data-act="copy">Copy</button><span class="d-run-result"></span></div>
  </div>`,
}

// ---- highlights ---------------------------------------------------------------

const hlRanges = new Set(), focusRanges = new Set()
function paintHighlights() {
  if (!window.CSS?.highlights) return
  CSS.highlights.set('d-draft', new Highlight(...hlRanges))
  CSS.highlights.set('d-focus', new Highlight(...focusRanges))
}

// ---- shell highlighting ---------------------------------------------------------

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
function highlightSh(cmd) {
  let first = true
  return cmd.split(/(\s+|&&|\|\||\||;)/).map((t) => {
    if (!t) return ''
    if (/^\s+$/.test(t)) return t
    if (/^(&&|\|\||\||;)$/.test(t)) { first = true; return `<span class="o">${esc(t)}</span>` }
    if (first) { first = false; return `<span class="c">${esc(t)}</span>` }
    if (/^-/.test(t)) return `<span class="f">${esc(t)}</span>`
    if (/^["']/.test(t)) return `<span class="s">${esc(t)}</span>`
    return esc(t)
  }).join('')
}

// ---- the message the agent gets -------------------------------------------------

function shortQuote(q) {
  q = q.trim().replace(/\s+/g, ' ')
  return q.length <= 100 ? q : q.split(' ').slice(0, 8).join(' ') + ' …'
}
const note = (q, t) => `> ${shortQuote(q)}` + (t.trim() ? `\n\n${t.trim()}` : '')
// As in the app: an emoji in a comment that has text goes on at the end, or comes off.
const toggleEmoji = (text, r) => text.includes(r) ? text.replace(r, '').replace(/ {2,}/g, ' ').trim() : text.trim() ? `${text.trimEnd()} ${r}` : r

// ---- one demo -------------------------------------------------------------------

class Demo {
  constructor(root) {
    this.root = root
    this.parts = (root.dataset.demo || Object.keys(PARTS).join(' ')).split(/\s+/)
    this.live = root.dataset.live ? document.getElementById(root.dataset.live) : null
    this.full = root.hasAttribute('data-full')
    this.keep = root.hasAttribute('data-preset')
    this.timer = null
    this.render()
    for (const ev of ['pointerdown', 'keydown', 'input', 'pointermove']) root.addEventListener(ev, () => this.touch(), { passive: true })
    root.addEventListener('mouseup', (e) => setTimeout(() => this.onSelect(e), 0))
    root.addEventListener('pointerdown', (e) => { const b = e.target.closest('.d-ack'); if (b) this.hold(e, b) })
    root.addEventListener('click', (e) => this.onClick(e))
    root.addEventListener('input', (e) => this.onInput(e))
    new ResizeObserver(() => this.layout()).observe(root)
  }

  render() {
    this.clearRanges()
    // A passage is what a comment or a reaction is on: a selection, a whole paragraph
    // (the reaction button) or an item to consider (Reply). reactions: passage → emoji.
    this.state = { notes: [], reactions: new Map(), items: {}, answer: null, answerText: '', composer: '', run: null, sent: false }
    this.wholes = new Map()
    this.last = '👍'
    this.railKey = ''
    const body = this.parts.map((p) => PARTS[p]).join('')
    this.root.innerHTML = this.full ? this.frame(body) : `<div class="d-main"><div class="d-col">${body}</div><div class="d-margin"></div></div>`
    this.col = this.root.querySelector('.d-col')
    this.rail = document.createElement('div')
    this.rail.className = 'd-rail'
    this.col.prepend(this.rail)
    this.margin = this.root.querySelector('.d-margin')
    for (const pre of this.root.querySelectorAll('pre[data-sh]')) pre.innerHTML = `<span class="p">$ </span>${highlightSh(pre.dataset.sh)}`
    for (const b of this.root.querySelectorAll('[data-react]')) {
      const g = document.createElement('button')
      g.className = 'd-ack'; g.innerHTML = '<span>👍</span>'
      b.classList.add('d-reactable'); b.prepend(g)
    }
    if (this.keep) this.preset()
    this.update()
  }

  // What the demo beside "What the agent sees" starts with: a reaction, a comment, a
  // reply to the item to consider, and an answer.
  preset() {
    const answer = this.col.querySelector('.d-answer')
    if (answer) this.toggleReact(this.wholeOf(answer), '👍')
    const para = this.col.querySelector('p.d-text')
    const text = para && [...para.childNodes].find((t) => t.nodeType === 3 && t.data.includes('compares the features.'))
    if (text) {
      const range = document.createRange(), at = text.data.indexOf('compares the features.')
      range.setStart(text, at); range.setEnd(text, at + 'compares the features.'.length)
      this.addNote({ quote: range.toString(), range, anchor: text, item: null }, 'Does it show the full feature list?')
    }
    const con = this.col.querySelector('.d-consider')
    if (con) this.addNote(this.itemPass(con), 'Do you know that price?')
    const pick = [...this.col.querySelectorAll('.d-ask [data-act="choose"]')].find((b) => b.textContent === '/plans')
    if (pick) this.choose(pick)
  }

  frame(body) {
    const row = (look, title, sub, on) => `<div class="d-sess${on ? ' on' : ''}" data-act="other-session"><span data-critter='${JSON.stringify({ ...look, size: 22 })}'></span><span><span class="d-st">${title}</span><small>${sub}</small></span></div>`
    return `<div class="d-window">
      <aside class="d-side">
        <div class="d-brand">Codinger <i class="d-dot"></i></div>
        ${row({ color: 'teal' }, 'Lead', 'idle · just now')}
        <div class="d-side-btns"><button class="d-primary" data-act="other-session">+ New session</button><button data-act="other-session">Resume…</button></div>
        <div class="d-dir">SHOP</div>
        ${row({ color: 'teal', hat: 'beret', held: 'pencil', status: 'asking' }, 'Pricing page', 'has questions · 1m ago', true)}
        ${row({ color: 'moss', hat: 'hard-hat', face: 'smile', walk: true }, 'Fix the build', 'working · now')}
        <div class="d-dir">API</div>
        ${row({ color: 'grape', hat: 'wizard', eyewear: 'round-glasses', status: 'permission' }, 'Migrate to Postgres', 'needs permission · 2m ago')}
        ${row({ color: 'gold', face: 'moustache', neck: 'bowtie', status: 'waiting' }, 'Rate limits', 'your turn · 4m ago')}
        ${row({ color: 'slate', hat: 'headphones', held: 'coffee', tired: true }, 'Long refactor', 'idle · 9m ago')}
      </aside>
      <div class="d-session">
        <header class="d-head"><span data-critter='{"color":"teal","hat":"beret","held":"pencil","status":"asking","size":34}'></span>
          <div><b>Pricing page</b><div class="d-head-sub"><span class="d-chip-st">has questions</span><code>~/Projects/shop</code></div></div>
          <span class="d-gauge"><i></i></span><small class="d-muted">40k / 1M</small></header>
        <div class="d-main"><div class="d-col">${body}</div><div class="d-margin"></div></div>
        <div class="d-composer"><div class="d-counts"></div>
          <div class="d-comp-row"><textarea class="d-comp-in" rows="1" placeholder="Message the agent"></textarea><button class="d-primary d-send" data-act="send">Send</button></div></div>
        <div class="d-sent" hidden><div class="d-sent-card"><div class="d-sent-head"><b>Sent. This is what the agent gets:</b></div><pre></pre>
          <div class="d-sent-foot"><small class="d-muted d-countdown"></small><button data-act="reset">Reset now</button></div></div></div>
      </div>
    </div>`
  }

  // Any use pushes the reset back; a reset only happens once something changed. The
  // full demo and a marked-up one never reset on their own (see send()).
  touch() {
    clearTimeout(this.timer)
    if (this.full || this.keep) return
    this.timer = setTimeout(() => {
      if (!this.dirty()) return
      if (this.root.contains(document.activeElement) && document.activeElement.value) return this.touch()
      this.reset()
    }, IDLE_MS)
  }
  reset() {
    clearTimeout(this.timer); clearInterval(this.countdown)
    this.root.classList.add('d-fading')
    setTimeout(() => { this.render(); this.root.classList.remove('d-fading'); window.paintCritters?.(this.root) }, 250)
  }
  dirty() {
    const s = this.state
    return s.sent || s.notes.length || s.reactions.size || Object.keys(s.items).length || s.answer || s.answerText || s.composer || s.run
      || this.root.querySelector('details[open], .d-activity.open')
  }

  clearRanges() {
    const passes = [...this.state?.notes.map((n) => n.pass) ?? [], ...this.state?.reactions.keys() ?? []]
    for (const p of passes) if (p.range) { hlRanges.delete(p.range); focusRanges.delete(p.range) }
    paintHighlights()
  }

  // ---- comments ----

  onSelect(e) {
    if (e.target.closest('button, input, textarea, .d-card, pre, summary')) return
    const sel = getSelection()
    if (!sel.rangeCount || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    const textRoot = this.col
    if (!textRoot || !textRoot.contains(range.commonAncestorContainer)) return
    const quote = sel.toString().replace(/[👍❤️💪🙏🎉🤔]/gu, '').trim()
    if (quote.length < 2) return
    sel.removeAllRanges()
    const anchor = range.startContainer
    this.addNote({ quote, range: range.cloneRange(), anchor, item: (anchor.nodeType === 1 ? anchor : anchor.parentElement).closest('.d-consider') })
  }

  // The passage of a whole paragraph, without its reaction button.
  wholeOf(block) {
    if (!this.wholes.has(block)) {
      const range = document.createRange()
      range.selectNodeContents(block); range.setStartAfter(block.querySelector(':scope > .d-ack'))
      this.wholes.set(block, { quote: range.toString().trim(), range, anchor: block, whole: true, item: block.closest('.d-consider') })
    }
    return this.wholes.get(block)
  }
  itemPass(con) {
    if (!this.wholes.has(con)) this.wholes.set(con, { quote: con.dataset.title, label: con.dataset.title, range: null, anchor: con.querySelector('.d-con-head'), whole: true, item: con })
    return this.wholes.get(con)
  }

  // A comment on a passage: the one open on it already, or a new card.
  commentOn(p) {
    const open = this.state.notes.find((n) => n.pass === p)
    if (open) return open.card.querySelector('textarea').focus()
    this.addNote(p)
  }

  addNote(p, text = '') {
    const n = { id: Math.random().toString(36).slice(2, 8), text, pass: p }
    this.state.notes.push(n)
    const card = document.createElement('div')
    card.className = 'd-card'; card.dataset.note = n.id
    card.innerHTML = `${p.label ? `<div class="d-card-q">${esc(p.label)}</div>` : ''}<button class="d-x" data-act="drop-note" title="Discard">✕</button>
      <textarea rows="1" placeholder="Comment"></textarea>
      <div class="d-card-emoji"></div>`
    n.card = card
    const ta = card.querySelector('textarea')
    ta.value = text
    ta.addEventListener('blur', () => setTimeout(() => { if (!n.text.trim() && !card.contains(document.activeElement)) this.dropNote(n.id) }, 150))
    card.querySelector('.d-card-emoji').addEventListener('mousedown', (e) => e.preventDefault())
    card.addEventListener('mouseenter', () => this.focusPass(p, true))
    card.addEventListener('mouseleave', () => this.focusPass(p, false))
    this.syncPass(p)
    this.placeCard(card, n)
    if (text) { this.grow(ta); this.layout() } else ta.focus()
    this.update()
  }

  focusPass(p, on) {
    if (!p.range) return
    if (on) focusRanges.add(p.range); else focusRanges.delete(p.range)
    paintHighlights()
  }

  // The emoji row of a card: the passage's reactions first, then the usual ones.
  paintCardEmoji(n) {
    const em = this.state.reactions.get(n.pass) ?? []
    n.card.querySelector('.d-card-emoji').innerHTML = [...new Set([...em, ...EMOJI])]
      .map((e) => `<button data-act="note-emoji" class="${n.text.includes(e) || em.includes(e) ? 'on' : ''}">${e}</button>`).join('')
  }

  // As in the app: on an empty card the emoji is a reaction, which goes to the left
  // of the passage, and the card goes too (unless the passage has reactions already:
  // then the card was opened from them, and stays). On a card with text it goes in the text.
  cardEmoji(n, r) {
    const p = n.pass, em = this.state.reactions.get(p) ?? []
    const ta = n.card.querySelector('textarea')
    if (!n.text.trim() && em.length) { this.toggleReact(p, r); return ta.focus() }
    if (!n.text.trim()) { this.toggleReact(p, r); return this.dropNote(n.id) }
    ta.value = toggleEmoji(ta.value, r)
    ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
  }

  inline() { return !this.margin || this.margin.offsetWidth < 40 }

  placeCard(card, n) {
    if (this.inline()) {
      const a = n.pass.anchor
      const block = (a.nodeType === 1 ? a : a.parentElement).closest('.d-col > *') ?? this.col.lastElementChild
      block.after(card)
    } else this.margin.append(card)
    this.layout()
  }

  dropNote(id) {
    const i = this.state.notes.findIndex((n) => n.id === id)
    if (i < 0) return
    const [n] = this.state.notes.splice(i, 1)
    n.card.remove()
    this.focusPass(n.pass, false)
    this.syncPass(n.pass)
    this.layout(); this.update()
  }

  // Cards sit level with their passage and stack downwards so they never overlap.
  layout() {
    this.paintRail()
    if (!this.margin || this.inline()) {
      if (this.margin) for (const n of this.state.notes) if (n.card.parentElement === this.margin) this.placeCard(n.card, n)
      return
    }
    const top0 = this.margin.getBoundingClientRect().top
    const cards = this.state.notes.map((n) => {
      if (n.card.parentElement !== this.margin) this.margin.append(n.card)
      const r = (n.pass.range ?? n.pass.anchor).getBoundingClientRect()
      return { n, want: r.top - top0 - 6 }
    }).sort((a, b) => a.want - b.want)
    let floor = 0
    for (const c of cards) {
      const top = Math.max(c.want, floor)
      c.n.card.style.top = `${top}px`
      floor = top + c.n.card.offsetHeight + 8
    }
    this.margin.style.minHeight = `${floor}px`
  }

  // ---- clicks ----

  onClick(e) {
    const b = e.target.closest('[data-act]')
    if (!b) return this.clickHighlight(e)
    if (!this.root.contains(b)) return
    const act = b.dataset.act
    const con = b.closest('.d-consider')
    if (act === 'toggle-activity') b.parentElement.classList.toggle('open')
    else if (act === 'dismiss') this.setItem(con, this.state.items[con.dataset.key] === 'dismissed' ? undefined : 'dismissed')
    else if (act === 'done') this.setItem(con, this.state.items[con.dataset.key] === 'done' ? undefined : 'done')
    else if (act === 'reply') this.commentOn(this.itemPass(con))
    else if (act === 'mark') this.commentOn(b.pass)
    else if (act === 'dismiss-ask') { const ask = b.closest('.d-ask'); this.state.answer = this.state.answer === 'dismissed' ? null : 'dismissed'; ask.classList.toggle('st-dismissed', this.state.answer === 'dismissed') }
    else if (act === 'choose') this.choose(b)
    else if (act === 'note-emoji') this.cardEmoji(this.state.notes.find((n) => n.card === b.closest('.d-card')), b.textContent)
    else if (act === 'drop-note') this.dropNote(b.closest('.d-card').dataset.note)
    else if (act === 'run') this.runInTerminal(b.closest('.d-run'))
    else if (act === 'copy') { navigator.clipboard?.writeText(RUN_CMD); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy' }, 1200) }
    else if (act === 'send') this.send()
    else if (act === 'reset') this.reset()
    else if (act === 'other-session') this.toast(b.closest('.d-window'), 'This demo has one live session. Install Codinger for the rest.')
    this.update()
  }

  // Clicking the highlight of a reaction to a selection opens a comment on it.
  clickHighlight(e) {
    if (!getSelection().isCollapsed || !this.col?.contains(e.target)) return
    const inside = (r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    const hit = [...this.state.reactions.keys()].find((p) => !p.whole && [...p.range.getClientRects()].some(inside))
    if (hit) { this.commentOn(hit); this.update() }
  }

  // As in the app: on a paragraph without reactions a click puts on your last emoji;
  // on one with reactions it opens the comment card, where they can change. Press and
  // hold, or drag up, for more emoji (and a comment), and let go on one.
  hold(e, btn) {
    e.preventDefault()
    const p = this.wholeOf(btn.parentElement)
    const pick = (emoji) => { if (emoji === 'comment') this.commentOn(p); else this.toggleReact(p, emoji); this.closePop(btn) }
    const picked = e.target.closest('[data-emoji]')
    if (picked) return pick(picked.dataset.emoji)
    if (btn.querySelector('.d-ack-pop')) return this.closePop(btn)
    const x0 = e.clientX, y0 = e.clientY
    let pop = null, over = null
    const open = () => {
      if (pop) return
      const mine = this.state.reactions.get(p) ?? []
      pop = document.createElement('div')
      pop.className = 'd-ack-pop'
      pop.innerHTML = [...new Set([...mine, ...EMOJI])].map((m) => `<span data-emoji="${m}" class="${mine.includes(m) ? 'on' : ''}" title="${mine.includes(m) ? `Remove ${m}` : `Add ${m}`}">${m}</span>`).join('')
        + `<span data-emoji="comment" class="d-pop-comment" title="Comment on this">${COMMENT_ICON}</span>`
      btn.append(pop); btn.classList.add('holding')
    }
    const timer = setTimeout(open, 350)
    const under = (ev) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-emoji]')
    const move = (ev) => {
      if (!pop && (y0 - ev.clientY > 8 || Math.abs(ev.clientX - x0) > 14)) open()
      if (!pop) return
      const t = under(ev)
      if (t !== over) { over?.classList.remove('over'); over = t; over?.classList.add('over') }
    }
    const up = (ev) => {
      clearTimeout(timer)
      removeEventListener('pointermove', move); removeEventListener('pointerup', up)
      if (!pop) { if (this.state.reactions.has(p)) this.commentOn(p); else this.toggleReact(p, this.last) }
      else { const t = under(ev); if (t) pick(t.dataset.emoji) }
      this.update()
    }
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  closePop(btn) { btn.querySelector('.d-ack-pop')?.remove(); btn.classList.remove('holding'); this.update() }

  toggleReact(p, emoji) {
    const em = this.state.reactions.get(p) ?? []
    const next = em.includes(emoji) ? em.filter((x) => x !== emoji) : [...em, emoji]
    if (!em.includes(emoji)) this.last = emoji
    if (next.length) this.state.reactions.set(p, next); else this.state.reactions.delete(p)
    this.syncPass(p)
  }

  // After a passage's comment or reactions change: its highlight (none for reactions to
  // a whole paragraph), its cards' emoji rows, and its item to consider.
  syncPass(p) {
    const noted = this.state.notes.some((n) => n.pass === p)
    if (p.range) {
      if (noted || !p.whole && this.state.reactions.has(p)) hlRanges.add(p.range)
      else { hlRanges.delete(p.range); focusRanges.delete(p.range) }
      paintHighlights()
    }
    for (const n of this.state.notes) if (n.pass === p) this.paintCardEmoji(n)
    const con = p.item
    if (con) {
      const st = this.state.items[con.dataset.key]
      this.setItem(con, this.itemHasReply(con) ? 'answered' : st === 'answered' ? undefined : st)
    }
  }

  // A comment or a reaction inside an item to consider counts as a reply to it.
  itemHasReply(con) {
    return [...this.state.reactions.keys()].some((p) => p.item === con) || this.state.notes.some((n) => n.pass.item === con)
  }

  // The left of the text: each paragraph's reaction button shows its reactions, and the
  // reactions to a selection sit level with the selection's first line, left of that button.
  paintRail() {
    if (!this.rail) return
    for (const [block, p] of this.wholes) {
      const ack = block.querySelector(':scope > .d-ack')
      if (!ack) continue
      const em = this.state.reactions.get(p) ?? []
      ack.firstElementChild.textContent = em.join('') || this.last
      ack.classList.toggle('on', em.length > 0)
      ack.title = em.length ? 'Comment, or change reactions (hold or drag up for more)' : 'React (click for your last emoji; hold or drag up for more)'
    }
    for (const ack of this.col.querySelectorAll('.d-ack:not(.on)')) ack.firstElementChild.textContent = this.last
    const c = this.col.getBoundingClientRect(), rows = []
    for (const [p, em] of this.state.reactions) {
      if (p.whole && this.wholes.get(p.anchor) === p) continue
      const box = (p.range ? p.range.getClientRects()[0] : null) ?? p.anchor.getBoundingClientRect()
      const mid = (box.top + box.bottom) / 2
      const a = (p.anchor.nodeType === 1 ? p.anchor : p.anchor.parentElement).closest('.d-reactable')?.querySelector(':scope > .d-ack')?.getBoundingClientRect()
      const x = a ? (Math.abs(mid - (a.top + a.bottom) / 2) < 9 ? a.left - 2 : a.right) : c.left - 6
      const row = rows.find((r) => Math.abs(r.mid - mid) < 6)
      if (row) { row.x = Math.min(row.x, x); row.marks.push([p, em]) } else rows.push({ mid, x, marks: [[p, em]] })
    }
    const key = JSON.stringify(rows.map((r) => [Math.round(r.mid - c.top), Math.round(r.x - c.left), r.marks.map(([p, em]) => em.join('') + p.quote)]))
    if (key === this.railKey) return
    this.railKey = key
    for (const p of this.state.reactions.keys()) if (!p.whole) focusRanges.delete(p.range)
    paintHighlights()
    this.rail.replaceChildren(...rows.map((r) => {
      const row = document.createElement('div')
      row.className = 'd-rail-row'
      row.style.top = `${r.mid - c.top - 11}px`; row.style.left = `${r.x - c.left}px`
      for (const [p, em] of r.marks) {
        const m = document.createElement('button')
        m.className = 'd-mark'; m.dataset.act = 'mark'; m.pass = p; m.textContent = em.join(''); m.title = 'Comment, or change reactions'
        m.addEventListener('mouseenter', () => this.focusPass(p, true))
        m.addEventListener('mouseleave', () => this.focusPass(p, false))
        row.append(m)
      }
      return row
    }))
  }

  setItem(con, st) {
    if (!con) return
    const key = con.dataset.key
    if (st) this.state.items[key] = st; else delete this.state.items[key]
    con.className = `d-consider${st ? ` st-${st}` : ''}`
  }

  choose(b) {
    const ask = b.closest('.d-ask')
    const pick = this.state.answer === b.textContent ? null : b.textContent
    this.state.answer = pick
    for (const c of ask.querySelectorAll('[data-act="choose"]')) c.classList.toggle('on', c.textContent === pick)
    ask.classList.remove('st-dismissed')
    ask.classList.toggle('st-answered', !!(pick || this.state.answerText))
  }

  onInput(e) {
    const t = e.target
    if (t.matches('.d-card textarea')) { const n = this.state.notes.find((x) => x.card === t.closest('.d-card')); n.text = t.value; this.paintCardEmoji(n); this.grow(t); this.layout() }
    else if (t.matches('.d-ask-in')) { this.state.answerText = t.value; t.closest('.d-ask').classList.toggle('st-answered', !!(t.value || (this.state.answer && this.state.answer !== 'dismissed'))) }
    else if (t.matches('.d-comp-in')) { this.state.composer = t.value; this.grow(t) }
    this.update()
  }
  grow(t) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px` }

  // ---- the pretend terminal ----

  runInTerminal(run) {
    document.querySelector('.d-term')?.remove()
    const win = document.createElement('div')
    win.className = 'd-term'
    win.innerHTML = `<div class="d-term-bar"><i style="background:#ff5f57" data-close></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>shop — zsh</span></div><pre></pre>`
    document.body.append(win)
    const pre = win.querySelector('pre')
    win.querySelector('[data-close]').onclick = () => win.remove()
    const res = run.querySelector('.d-run-result')
    res.textContent = 'Running…'; res.className = 'd-run-result'
    let i = 0
    const prompt = '<span class="p">~/Projects/shop $ </span>'
    const typeCmd = () => {
      pre.innerHTML = prompt + esc(RUN_CMD.slice(0, i))
      if (i++ < RUN_CMD.length) return setTimeout(typeCmd, 60)
      let line = 0
      const out = () => {
        if (!win.isConnected) return
        if (line < RUN_OUT.length) { pre.innerHTML += '\n' + esc(RUN_OUT[line++]).replace(/✓/g, '<span class="ok">✓</span>'); this.touch(); return setTimeout(out, 140) }
        pre.innerHTML += `\n${prompt}`
        this.state.run = { code: 0, out: RUN_OUT.filter(Boolean).slice(-3).map((l) => l.trim()).join('\n') }
        this.state.items[run.dataset.key] = 'done'
        run.classList.add('st-done')
        res.innerHTML = '<span class="ok">✓ exit 0</span> · result sent with your next message'
        this.update()
        setTimeout(() => win.classList.add('d-term-out'), 2200)
        setTimeout(() => win.remove(), 2600)
      }
      setTimeout(out, 250)
    }
    typeCmd()
  }

  toast(where, text) {
    if (!where) return
    where.querySelector('.d-toast')?.remove()
    const t = document.createElement('div')
    t.className = 'd-toast'; t.textContent = text
    where.append(t); setTimeout(() => t.remove(), 2200)
  }

  // ---- what the agent gets ----

  message() {
    const s = this.state, out = [], done = [], dismissed = []
    const entries = []
    for (const n of s.notes) if (n.text.trim()) entries.push({ at: n.pass.anchor, text: note(n.pass.quote, n.text) })
    for (const [p, em] of s.reactions) for (const e of em) entries.push({ at: p.anchor, text: note(p.quote, e) })
    const ask = this.root.querySelector('.d-ask')
    if (ask && s.answer !== 'dismissed' && (s.answer || s.answerText.trim())) {
      const lines = [`**Answer to your question \`${ask.dataset.id}\`** ("${ask.dataset.q}"):`]
      if (s.answer) lines.push(`Chose: ${s.answer}`)
      if (s.answerText.trim()) lines.push(s.answerText.trim())
      entries.push({ at: ask, text: lines.join('\n') })
    }
    entries.sort((a, b) => a.at === b.at ? 0 : a.at.compareDocumentPosition(b.at) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    out.push(...entries.map((e) => e.text))
    for (const el of this.root.querySelectorAll('[data-key]')) {
      const st = s.items[el.dataset.key], label = `\`${el.dataset.key}\` (${el.dataset.title})`
      if (st === 'done') done.push(label)
      if (st === 'dismissed') dismissed.push(label)
    }
    if (ask && s.answer === 'dismissed') dismissed.push(`\`${ask.dataset.id}\` (${ask.dataset.q})`)
    if (dismissed.length) out.push(`**Dismissed, no reply:** ${dismissed.join('; ')}`)
    if (done.length) out.push(`**Marked done:** ${done.join('; ')}` + (s.run ? `\n\nResult for \`r1\`:\n\`\`\`\n$ ${RUN_CMD}\nexit code ${s.run.code}\n${s.run.out}\n\`\`\`` : ''))
    if (s.composer.trim()) out.push(s.composer.trim())
    return out.join('\n\n')
  }

  update() {
    const s = this.state
    this.paintRail()
    const msg = this.message()
    if (this.live) this.live.textContent = msg || 'Nothing yet. Select some text on the left, react to a paragraph, or pick an answer.'
    const counts = this.root.querySelector('.d-counts')
    if (counts) {
      const n = s.notes.filter((x) => x.text.trim()).length, r = [...s.reactions.values()].flat().length, a = s.answer && s.answer !== 'dismissed' || s.answerText.trim() ? 1 : 0
      const open = (this.root.querySelector('.d-consider') && !s.items.c1 ? 1 : 0) + (this.root.querySelector('.d-ask') && !a && s.answer !== 'dismissed' ? 1 : 0)
      const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`
      counts.innerHTML = [n && pl(n, 'comment'), r && pl(r, 'reaction'), a && pl(a, 'answer'), open && `${open} open`].filter(Boolean).map((t) => `<span>${t}</span>`).join('')
      const send = this.root.querySelector('.d-send')
      const total = n + r + a + (s.composer.trim() ? 1 : 0) + Object.keys(s.items).length
      send.textContent = total ? `Send ${total}` : 'Send'
      send.disabled = !total
    }
  }

  send() {
    const msg = this.message()
    if (!msg) return
    this.state.sent = true
    const box = this.root.querySelector('.d-sent')
    box.querySelector('pre').textContent = msg
    box.hidden = false
    // The full demo starts over a while after you send, or when you say so.
    let left = SENT_S
    const tick = () => { box.querySelector('.d-countdown').textContent = `The demo starts over in ${left} s.`; if (left-- <= 0) this.reset() }
    clearInterval(this.countdown)
    tick(); this.countdown = setInterval(tick, 1000)
  }
}

for (const el of document.querySelectorAll('[data-demo]')) new Demo(el)
