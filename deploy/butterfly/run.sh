#!/usr/bin/env bash
# Butterfly: a named agent on this laptop, open to anyone with the tunnel's link.
# Codinger listens on 127.0.0.1:4549; a Cloudflare quick tunnel gives it a public https URL.
# People type a name (CODINGER_ASK_NAME); a Tailscale header, if a proxy sets one, wins.
# No shell for Claude or the page (CODINGER_NO_SHELL).
#   run.sh          the server and the tunnel
#   run.sh server   the server only: restart it while the tunnel (and its URL) stays
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
export PORT=4549
export CODINGER_HOME="$HOME/.codinger-butterfly"
export CODINGER_HOSTS='*.trycloudflare.com'
export CODINGER_USER_HEADER=Tailscale-User-Login
export CODINGER_ASK_NAME=1
export CODINGER_NO_SHELL=1
export CODINGER_AGENT_NAME=Butterfly
export CODINGER_AGENT_AVATAR="$here/avatar.svg"
export CODINGER_AGENT_CSS="$here/theme.css"
export CODINGER_AGENT_COLOR='#6b3fa0'
mkdir -p "$CODINGER_HOME" "$HOME/dev/agents/butterfly"
[ -f "$CODINGER_HOME/AGENTS.md" ] || cp "$here/AGENTS.md" "$CODINGER_HOME/AGENTS.md"
cd "$repo"
[ "${1:-}" = server ] && exec node server/index.ts
node server/index.ts &
server=$!
trap 'kill $server 2>/dev/null' EXIT
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT"
