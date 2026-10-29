#!/bin/bash
# Turn on Codinger as one agent's desk, on a host set up by hand: the systemd unit, the
# Caddy site and the AGENTS.md. Run from a laptop with SSH to ubuntu@<host> (sudo). Code is
# already built in /opt/codinger and Node is in /opt/node (see deploy/README.md).
#   deploy/install.sh ada-host ~/ada-desk ada ~/.ada-env
# The folder holds codinger.env, caddy-site and AGENTS.md; the env file (optional, on the
# host) is sourced before the server starts, e.g. for Claude Code on Bedrock.
set -euo pipefail
HOST=${1:?host}; D="$(cd "${2:?folder with codinger.env, caddy-site, AGENTS.md}" && pwd)"
AGENT_USER=${3:?the agent user}; SOURCE=${4:-}
unit=$(mktemp)
cat > "$unit" <<EOF
[Unit]
Description=Codinger, an agent's desk, behind Caddy
After=network-online.target

[Service]
User=$AGENT_USER
WorkingDirectory=~
EnvironmentFile=/etc/codinger/codinger.env
ExecStart=/bin/bash -c '${SOURCE:+source $SOURCE; }export PATH=/opt/node/bin:\$PATH; exec node /opt/codinger/server/index.ts'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
scp -q "$unit" "ubuntu@$HOST:/tmp/codinger-workwith.service"
scp -q "$D/codinger.env" "$D/caddy-site" "$D/AGENTS.md" "ubuntu@$HOST:/tmp/"
rm -f "$unit"
ssh "ubuntu@$HOST" "AGENT_USER=$AGENT_USER bash -s" <<'REMOTE'
set -e
home=$(getent passwd "$AGENT_USER" | cut -d: -f6)
sudo install -d -m755 /etc/codinger
sudo install -m640 -g "$AGENT_USER" /tmp/codinger.env /etc/codinger/codinger.env
sudo install -d -o "$AGENT_USER" -g "$AGENT_USER" "$home/.codinger"
sudo install -m644 -o "$AGENT_USER" -g "$AGENT_USER" /tmp/AGENTS.md "$home/.codinger/AGENTS.md"
sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M)"
cat /etc/caddy/Caddyfile /tmp/caddy-site > /tmp/Caddyfile.new
# validate provisions the DNS module, so it may need what the caddy unit loads first.
sudo caddy validate --config /tmp/Caddyfile.new --adapter caddyfile >/dev/null && echo "Caddyfile valid"
sudo install -m644 /tmp/codinger-workwith.service /etc/systemd/system/
sudo install -m644 /tmp/Caddyfile.new /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now codinger-workwith
sudo systemctl reload caddy
sleep 2; systemctl is-active codinger-workwith caddy
REMOTE
