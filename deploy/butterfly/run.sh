#!/usr/bin/env bash
# Butterfly: a named agent on this laptop, open to anyone with the tunnel's link.
# Codiner listens on 127.0.0.1:4549; a Cloudflare quick tunnel gives it a public https URL.
# People type a name (CODINER_ASK_NAME); a Tailscale header, if a proxy sets one, wins.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
export PORT=4549
export CODINER_HOME="$HOME/.codiner-butterfly"
export CODINER_HOSTS='*.trycloudflare.com'
export CODINER_USER_HEADER=Tailscale-User-Login
export CODINER_ASK_NAME=1
export CODINER_AGENT_NAME=Butterfly
export CODINER_AGENT_AVATAR="$here/avatar.svg"
export CODINER_AGENT_CSS="$here/theme.css"
export CODINER_AGENT_COLOR='#6b3fa0'
mkdir -p "$CODINER_HOME" "$HOME/dev/agents/butterfly"
[ -f "$CODINER_HOME/AGENTS.md" ] || cp "$here/AGENTS.md" "$CODINER_HOME/AGENTS.md"
cd "$repo"
node server/index.ts &
server=$!
trap 'kill $server 2>/dev/null' EXIT
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT"
