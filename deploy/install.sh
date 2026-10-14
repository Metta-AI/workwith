#!/bin/bash
# Turn on Codiner for one agent host: the systemd unit and the Caddy site.
# Run from a laptop with Tailscale SSH to ubuntu@<host> (sudo). Code is already in
# /opt/codiner and Node in /opt/node (see deploy/README.md).
#   deploy/install.sh synth synth-host
set -euo pipefail
AGENT=${1:?agent, e.g. synth}; HOST=${2:?host, e.g. synth-host}
D="$(cd "$(dirname "$0")/$AGENT" && pwd)"
scp -q "$D/codiner-workwith.service" "$D/caddy-site" "ubuntu@$HOST:/tmp/"
ssh "ubuntu@$HOST" 'set -e
  if grep -q "^workwith\." /etc/caddy/Caddyfile; then echo "Caddy site already present"; exit 1; fi
  sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M)
  cat /etc/caddy/Caddyfile /tmp/caddy-site > /tmp/Caddyfile.new
  # validate provisions the DNS module, so it needs the token the caddy unit loads.
  sudo sh -c "set -a; . /run/caddy-cf.env; caddy validate --config /tmp/Caddyfile.new --adapter caddyfile 2>/dev/null" && echo "Caddyfile valid"
  sudo install -m644 /tmp/codiner-workwith.service /etc/systemd/system/
  sudo install -m644 /tmp/Caddyfile.new /etc/caddy/Caddyfile
  sudo systemctl daemon-reload
  sudo systemctl enable --now codiner-workwith
  sudo systemctl reload caddy
  sleep 2; systemctl is-active codiner-workwith caddy'
echo "Open https://workwith.$AGENT.example.com"
