# Codinger as an agent's desk ("work with <agent>")

One Codinger per agent host, running as the agent's user in its home, on 127.0.0.1. A
reverse proxy in front of it signs people in and names them in a header, so Claude knows
who is writing (`CODINGER_USER_HEADER`). With `CODINGER_AGENT_NAME` set, the page is that
agent's desk: its name, face and colours, an installable app, and replies signed by person.
`server/agent.ts` lists every setting.

Agent hosts at Softmax are set up by agents-toolkit (private, Metta-AI/agents-toolkit): it
builds a tagged release into `/opt/codinger/releases/<tag>`, writes the settings and the
systemd unit, adds the Caddy site, and goes back to the last release if the new one fails
its health check. The files here are for setting up one host by hand.

By hand, once per host:
1. Node 24 in `/opt/node`, and this repository built (`npm ci && npm run build`) in
   `/opt/codinger`.
2. A folder with `codinger.env` (the settings; see `server/agent.ts`), `caddy-site` (the
   proxy's site for this host) and `AGENTS.md` (the "work with" framing).
3. `deploy/install.sh <host> <folder> <agent user> [env file to source]`: the systemd unit,
   the Caddy site, and the AGENTS.md, over SSH with sudo.

Update: build in `/opt/codinger`, then `sudo systemctl restart codinger-workwith`.

`butterfly/` runs a named agent on a laptop behind a Cloudflare quick tunnel, for a demo.
