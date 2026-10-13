#!/bin/sh
# Renders site/og.png, the preview image for links to codiner.app, from the page
# itself (its #og layout). Run it after you change the top of the page.
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE=$(mktemp -d)
"$CHROME" --headless --disable-gpu --hide-scrollbars --blink-settings=preferredColorScheme=1 --user-data-dir="$PROFILE" \
  --window-size=1200,630 --virtual-time-budget=2000 \
  --screenshot="$PWD/site/og.png" "file://$PWD/site/index.html#og" 2>/dev/null
rm -rf "$PROFILE"
echo "Wrote site/og.png"
