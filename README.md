# Codiner

A web UI over Claude Code where you reply the way you'd mark up a draft: select any
passage of Claude's answer and comment on it in the margin, answer its questions
where it asks them, and send everything you've queued in one go. Several sessions run
side by side, each with a little critter showing what it's doing and how tired it is,
and a master agent watches over the lot.

```bash
npm install
npm run dev        # http://localhost:4545, UI hot-reloads
npm start          # build the UI, then serve it
```

Needs Node 23.6+ (it runs the TypeScript server directly) and the `claude` CLI, logged in.

## It runs on your Claude Code login, not the API

Every session is a real `claude -p --input-format stream-json --output-format stream-json`
process: the same headless protocol the Agent SDK uses, but driven by your own installed
Claude Code. It uses your subscription login, settings, CLAUDE.md, skills and MCP servers. The server
deletes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child's environment, so
it can't fall back to per-token billing, and posts a warning in the transcript if Claude
ever reports a key-based auth source. The sidebar footer shows your plan's 5-hour and
7-day usage as Claude Code reports it.

## Replying

- **Comments in the margin.** Select text in any of Claude's messages and a comment card
  opens in the right margin, level with the passage, focused and ready to type, the way
  Marginer does it. The passage stays highlighted; hovering it lights up its card. Cards that would overlap stack
  downward, and the one you're typing in stays pinned to its passage. An empty card
  disappears when you click away; the X discards one. When the window is too narrow for a
  margin, cards sit under their passage instead. Selecting text just to copy it opens a
  card too, which vanishes as soon as you click elsewhere.
- **Five kinds of content.** Claude is told (via `--append-system-prompt`) to mark its
  replies with XML tags on their own lines, and each kind looks different:
  - `<answer>`: the direct answer, marked in the accent colour;
  - `<details title="…">`: supporting detail, folded to its title;
  - `<consider title="…">`: an item that wants your attention, as an amber card with an X
    (dismiss) at the top and a Reply button at the bottom;
  - `<ask id="…">`: a question with suggested answers to click, a text box, and an X;
  - `<run title="…">`: a command for you to run yourself (one that restarts Codiner, needs
    sudo, or is interactive), with **Run in Terminal** (macOS: a new Terminal window in the
    session's directory, via a self-deleting `.command` file) and **Copy**.

  Sections render as the reply streams in. The older ` ```ask ` and `:::more` forms still
  parse. Parsing is in `shared/blocks.ts`.
- **Done.** Items that are something to do (`<consider title="…" done>`, or any item with a
  `<run>` command) get a Done button, with room to say what went wrong; Claude gets one
  "Marked done" line. A command run from an item reports its exit code and output back
  (the Terminal script runs it under `script` and calls the server when it ends), and that
  result goes into the item's Done.
- **Reactions.** Move the pointer level with a paragraph or list item (over it, or in the left
  gutter) and a 👍 shows at its left: click it, or press and hold (or drag up) for your most
  used emoji and let go on one, or on + to search them all. Reactions stay at the left of their
  passage; hovering one shows the passage. An emoji on an empty comment card is a reaction too,
  so it moves to the left; the right margin is for comments with words. Most used come first.
- **Markdown keys.** In every input, Cmd+B, Cmd+I, Cmd+E (code), Cmd+Shift+X (strikethrough)
  and Cmd+K (link) wrap the selection, or unwrap it.
- **Sent replies stay put.** Sent comments stay in the margin as read-only cards; your sent
  message shows what you typed, with comments, reactions and answers folded into one line
  ("2 comments, 1 reaction").
- **Steps fold away.** Once a turn ends, Claude's in-between messages fold into the activity
  row ("2 updates · 3 edits"), unless they hold questions, items or comments. Settings has a
  switch to keep them in view.
- **Nothing slips past.** The panel on the right lists the open questions and items, to
  answer or dismiss there. Completed ones (answered or dismissed) fold into a group below,
  with what you replied, and carry a check or an X in the transcript. Hide the panel with
  its X or the header button; drag its edge to resize it.
  Commenting on an item, or on any text inside it, counts as replying to it. If you send
  while some are still open, the first Send only warns ("2 open", and the button reads
  **Send anyway**); the second dismisses the rest and sends. Claude gets one "Dismissed, no
  reply" line for everything you set aside.
- **In the sent message** each comment shows its quoted passage, each answer its question,
  and the dismissed items one line.
- **Images anywhere.** Paste, drop or attach images into a comment, an answer, or the
  composer. Each one sits in the text where you put it, as a small thumbnail (click for full
  size), and Claude gets text and images in that order. Large ones are scaled down before
  upload. In the text they are markdown image links (`shared/images.ts`).
- **Send.** One message carries everything, in reading order: each comment as
  `> quoted passage` + your note (Marginer's format), each answer, then the composer.
  Drafts survive a reload (localStorage). Hover a sent comment to darken its passage; click
  it to scroll there.

The anchoring (quote text plus which occurrence of it) is Marginer's own `anchor.ts`, vendored
in `web/src/vendor/anchor.ts` (from [huttj/marginer](https://github.com/huttj/marginer)). Each markdown block is its own anchoring root, so
cards inserted between blocks never shift a quote, and highlights are painted with the
CSS Custom Highlight API instead of DOM changes.

- **Edit, or delete from here.** Hover one of your messages for a pencil and a bin under it. Edit
  reopens it in place; Send drops it and everything after it, then sends the new version.
  The bin (click twice) just drops it and everything after. Claude forgets them too: the
  next start resumes its transcript cut just before that message
  (`--resume-session-at`, as a `--fork-session`, so the original stays in Claude Code's
  history). Files Claude changed after that point stay changed.

## Signing in

If Claude Code's login is missing (checked at start) or a turn fails because it expired,
Codiner runs `claude auth login`, which opens the sign-in page in your browser. A banner
shows while it waits, with the page's link and a box for the code that page shows if the
sign-in can't finish by itself. Once signed in, the message that failed is sent again in its
own place. Only a missing login at start or an auth failure starts it by itself (not again
within a minute of a sign-in that worked); the banner's Sign in button starts it any time. The code is in `server/auth.ts`.

## Code

Commands, the files Claude writes or edits, `<run>` blocks and fenced code in messages are
syntax highlighted (highlight.js, common languages only: `web/src/highlight.ts`).

## Other agents

Before each message to a worker, if `~/.claude/bin/agents` exists, the server runs
`agents active <dir>` and adds the result to the message, out of the transcript, so Claude
knows who else is at work there without checking.

## Sessions

- **New session** picks a directory from a dropdown of recent ones (from Codiner *and* from
  every Claude Code session on this machine), an in-place folder browser, or the native
  macOS folder dialog (**Finder…**).
- **Resume…** lists every Claude Code conversation on this machine, terminal ones included,
  searchable by title, folder and prompt. Opening one imports its transcript and continues
  it with `--resume`. Only the first and last 256 KB of each file are read for the list.
- **Slash commands:** type `/` in the composer for the session's commands with descriptions:
  built-ins, your skills, project commands. A message that is just a slash command runs it
  as if typed at the `claude` prompt (`/model sonnet`, `/clear`, `/context`, `/code-review`…).
  The few that only exist in the interactive terminal UI (`/doctor`, `/color`…) are left out.
- **Close** (header, or × on a sidebar row) ends the process and moves the session to
  Archived. **Reopen** brings it back; **Delete** removes it from Codiner (Claude Code keeps
  its own copy, so it's still under Resume).
- The sidebar and the master view's board are resizable: drag the edge, double-click to reset.
- Grouped by directory in the sidebar; a session started as a sub-task of another
  nests under it.
- `/clear` gives Claude a new conversation id; Codiner follows it, so a later resume picks up
  the cleared conversation, not the old one.
- Thinking and tool calls between two pieces of Claude's text collapse into one line that
  counts them ("Thinking · 5 edits · 3 commands"); click it for the individual calls, and
  click a call for its input and output (edits show as diffs). While Claude works, the
  call in progress shows under that line.
- Permission requests arrive as cards: Allow, Always allow, or Deny with a reason Claude
  sees. Once answered, the card becomes a mark on its tool's line.
- Every session, the master included, starts in **auto mode**, Claude Code's
  classifier-based mode that runs most commands without asking.
- The header has the permission mode (switchable mid-session), Stop (interrupt), Close,
  and the context gauge with **Compact**.
- The process is started on the first message. Five minutes after a turn ends, an idle
  session's process exits on its own (`IDLE_SLEEP_MS` in `server/session.ts`), and the
  next message resumes it with `--resume`. A session never sleeps while it works, waits
  on a permission prompt, compacts, or has background commands or agents running. A
  server restart resumes the same way, so nothing is lost.

### The critter

Each Claude dresses its own critter. Every session has Codiner's `set_look` tool
(pre-approved, served from Codiner's MCP endpoint alongside your own MCP servers), and a
session without a look is told to pick one early in its next turn: a colour, a hat, hair,
eyewear, a face, something at the neck, something to hold. The options are in
`shared/looks.ts`, the pixel drawings in `web/src/components/looks.tsx`.

Its pose is the status: walking while working, `!` when it needs a permission, `?` when it
asked you something, a green dot when it's your turn, `×` on errors. Its face is the
context: eyes droop and it sweats past ~55%, it falls asleep past ~85%, and it greys
out as it fills. Tiredness is measured against at most 400k tokens even on 1M-window
models, since quality slips well before the window is full.

## The master agent

The **Master** view shows every session as a card beside a chat with a separate
Claude Code session whose only tools are its notes and a small MCP server Codiner hosts:

| Tool | |
|---|---|
| `list_sessions` | status, context use, open questions, tail of the last message |
| `read_session` | condensed recent transcript, capped by `max_chars` |
| `send_to_session` | message a worker. Lands in its **inbox** for you to Send / Edit / Dismiss, unless **Auto-send** is on |
| `spawn_session` | start a worker in a directory, optionally with a first prompt |
| `compact_session` | `/compact` a worker that's getting heavy |
| `interrupt_session` / `close_session` | stop a turn / archive a finished worker |
| `find_past_sessions` / `resume_past_session` | search all Claude Code history and bring a session into Codiner |

Because workers are full Claude Code sessions, `send_to_session` with just a slash command
runs it there. The master can't change permission modes; that stays with you.

Each message you send it carries a one-line-per-session `<board>` snapshot, so it rarely
needs to call anything just to know what's going on.

**Keeping its context small:** it runs with `--strict-mcp-config` (none of your other MCP
servers), only Read/Write/Edit/Glob/Grep, and `--autocompact 200k`. It keeps durable notes
in `NOTES.md` in its working directory, so **Fresh start** (a new conversation) costs
nothing it meant to remember.

## AGENTS.md: instructions for every session

`~/.codiner/AGENTS.md` is added to the system prompt of every session, workers and master
alike. Edit it in **Settings** (the gear at the bottom of the sidebar). The first run
creates it with the rules of ASD-STE100 Simplified Technical English for the text Claude
writes to you. (How to mark the four kinds of content is Codiner's own prompt, in
`server/prompts.ts`.) It is read
when a session's process starts, so an edit reaches a running session the next time it
wakes from sleep.

## Where things live

`~/.codiner/` (override with `CODINER_HOME`): `AGENTS.md`, `sessions.json`, one append-only
`events/<id>.jsonl` per session, pasted `images/`, and `master/` (the master's working
directory). Claude Code keeps its own transcripts as usual, so any session can also
be picked up with `claude --resume`.

## Safety

The server listens on 127.0.0.1 only. It rejects requests whose `Host` or `Origin` isn't
itself, so a web page you visit can't open the WebSocket or call the API and run
Claude in your directories. The MCP endpoint's path includes a random token that changes
on every server start.

## Layout

```
server/index.ts     HTTP + WebSocket, session registry, master tools, Vite in dev
server/session.ts   one claude process: stream-JSON in/out, permissions, status, context
server/mcp.ts       minimal MCP-over-HTTP (JSON-RPC, no SSE)
server/history.ts   Claude Code's own history: list, import a transcript, browse folders
server/prompts.ts   what workers and the master are told
server/agentsmd.ts  the global AGENTS.md: defaults, reading, editing
shared/             types and ask-block parsing used by both sides
web/src/            React UI: store.ts (state + socket), anchoring.ts (Marginer), components/
```
