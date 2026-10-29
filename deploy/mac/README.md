# Codinger on a Mac on your tailnet

A Mac you keep on (a Mac mini at home) runs Codinger from a git checkout, on your Claude
subscription, at `https://<mac>.<tailnet>.ts.net`. `tailscale serve` gives it HTTPS and
names each person in `Tailscale-User-Login` (it strips one the browser sends), so replies
are signed by whoever wrote them. Who can reach it is your tailnet's ACLs: Codinger trusts
the header and checks nothing else.

Once, on the Mac: Homebrew, `brew install node tailscale`, Tailscale up (`sudo brew services
start tailscale; tailscale up`), Claude Code installed and logged in, Remote Login on.
Then, from a laptop with SSH to it:

```bash
deploy/mac/install.sh mini "ada@gmail.com=Ada,grace@gmail.com=Grace"
```

It clones the repository on the Mac (`~/dev/workwith`), writes `~/.codinger/desk.env` (the
settings, kept on a re-run), loads the launchd job `app.codinger.desk` and runs `tailscale
serve`. The first time, Tailscale prints a link to turn on Serve for the tailnet.

- **Changes from the laptop:** `git push mini main`. The checkout updates and Codinger
  restarts itself (`npm install` first if the packages changed). The push is refused while the
  Mac's checkout has uncommitted changes. `git push -f mini my-branch:main` tries a branch.
- **From GitHub:** Codinger's updater offers what's on origin/main every 10 minutes.
- **Made on the Mac:** commit there and push to GitHub (`gh auth login` on the Mac once), or
  fetch it from the laptop: `git fetch mini && git push origin mini/main:main`.
- **Settings:** edit `~/.codinger/desk.env`, then restart from the page or
  `launchctl kickstart -k gui/$(id -u)/app.codinger.desk`.

Notes:
- The job is a LaunchAgent, not a LaunchDaemon: Claude Code keeps its login in the Keychain,
  so someone must be logged in to the Mac. `sudo pmset autorestart 1` brings it back after a
  power cut (with automatic login, it comes all the way back).
- `CODINGER_SUPERVISED=1` (in `desk.env`): a restart only stops the server, handing busy
  sessions on, and launchd starts the next one; `run.sh` builds the page first. Sessions and
  tasks run in their own process groups, so they outlive the server.
- Logs: `~/.codinger/launchd.log`, `~/.codinger/server.log`.
