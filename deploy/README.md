# Codiner for agent hosts ("work with <agent>")

One Codiner per agent EC2 host, running as the agent's user (`cubid`) in its home, on
127.0.0.1:4545. Caddy serves it at `workwith.<agent>.example.com` (DNS-only A record
to the tailnet IP), lets only guardians in by Tailscale login, and passes
`Tailscale-User-Login` on, so Claude knows who is writing (`CODINER_USER_HEADER`).

Per host, once:
1. Node 24 in /opt/node (official tarball, sha256 checked).
2. Build `dist/` on the laptop (`npm run build`), then
   `rsync -az --delete --exclude node_modules --exclude .git ./ ubuntu@<host>:/opt/codiner/`
   and `npm ci --omit=dev` there.
3. `<agent>/AGENTS.md` → `~cubid/.codiner/AGENTS.md` (the "work with" framing).
4. `deploy/install.sh <agent> <host>` (systemd unit + Caddy site; needs sudo).

Update: build, rsync, then `sudo systemctl restart codiner-workwith`.
