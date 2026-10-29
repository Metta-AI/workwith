#!/bin/bash
# Started (and kept alive) by launchd, as ~/.codinger/run.sh <checkout>: the job
# deploy/mac/install.sh writes. The settings (CODINGER_*, PORT) come from ~/.codinger/desk.env.
# Codinger restarts itself by starting a new, detached server and exiting (server/index.ts,
# restart()), and that server's command line names server/index.ts from the start, while it
# builds. So launchd starting this again must not race it: wait while any server of this
# checkout is up, then build and take over. If that detached server ever dies, this one
# takes its place within a few seconds.
set -u
W=${1:?the checkout}
cd "$W" || exit 1
if [ -f "$HOME/.codinger/desk.env" ]; then set -a; . "$HOME/.codinger/desk.env"; set +a; fi
sleep 2
while pgrep -qf "$W/server/index.ts"; do sleep 5; done
npx vite build >> "$HOME/.codinger/server.log" 2>&1 || echo "vite build failed; serving the last build" >&2
exec node "$W/server/index.ts"
