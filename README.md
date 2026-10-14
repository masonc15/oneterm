<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <img src=".github/assets/logo-light.svg" alt="oneterm" width="360">
  </picture>
</p>

<p align="center"><strong>OneTab for Ghostty tabs and their agent sessions.</strong></p>

One command saves Ghostty tabs and their pi, Claude Code, or Codex sessions to a list and closes the tabs. Later you reopen them one at a time instead of facing the whole pile again. Sessions on remote machines over SSH work too.

<p align="center">
  <img src=".github/assets/screenshot.png" alt="The oneterm page: stashed terminals grouped by when they were stashed, with restore and delete links" width="760">
</p>

## How it works

`oneterm stash` asks Ghostty for every open tab and looks at what each terminal is running. An idle shell is saved as its working directory. A pi, Claude Code, or Codex session is saved by its exact session ID, which the agent reports itself through a pi extension or lifecycle hooks. An SSH session to a host you've set up is saved as whatever is running on the far end, so you get the remote agent back, not just `ssh host`. Anything else (an editor, a dev server, an agent without the hooks) stays open, and oneterm tells you why.

Busy agents aren't killed. The tool call that's running finishes and its result is saved, new tool calls are refused, and the agent stops before its next model request. That session shows up as "stopped mid-task"; say "continue" after you reopen it. If an agent can't reach a safe stop within two minutes, its tab stays open.

Restoring opens a new tab in the saved directory and runs `pi --session <file>`, `claude --resume <id>`, or `codex --no-daemon resume <id>`, over SSH for remote sessions. Terminals that shared a tab come back as splits.

## Usage

```sh
oneterm stash              # every tab (--others: all but the front one, --this: just it)
oneterm stash --dry-run    # show what would be saved and what would stay open
oneterm restore            # fzf picker; Tab selects several, Ctrl-D deletes
oneterm ls
oneterm open               # the web page
```

In pi, `/oneterm [all|others|this]` does the same.

The web page is a OneTab-style list served by a small hub on an always-on server, so it works from your phone and while the Mac is asleep. Click an entry to reopen it, drag entries between groups, or delete them. Clicks made while the Mac is offline wait and run when it's back. The hub only ever sends item IDs to the Mac, never commands.

When more than 6 tabs are open, you get a notification with a "Stash all tabs" button. Set `tabCap` (0 turns it off) and `nudgeRepeatMinutes` in `~/.oneterm/config.json`.

## Setup

You need macOS, Ghostty 1.3+, Node 22.18+, Python 3.9+, fzf, and terminal-notifier. Clone to `~/workspace/oneterm`; the pi extension, LaunchAgent, and Raycast scripts expect that path.

```sh
ln -s ~/workspace/oneterm/bin/oneterm ~/.local/bin/oneterm
pi install ~/workspace/oneterm                 # pi extension
python3 support/agents.py --install            # Claude Code and Codex hooks
cp launchd/com.colin.oneterm-agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.colin.oneterm-agent.plist
cp raycast/*.sh ~/raycast/script-commands/     # optional hotkey commands
```

The hook installer merges into your existing `~/.claude/settings.json` and `~/.codex/hooks.json` and keeps backups in `~/.oneterm/backups/`. Codex then wants you to trust the new hooks once in `/hooks`. Codex also has to run with `--no-daemon`, because its shared background server hides which terminal a session belongs to; add that flag in a shell wrapper for interactive `codex` calls.

For remote sessions, copy `support/agents.py` to `~/.oneterm/agents.py` on the server, run it with `--install` there, and add the host to `remoteHosts` in the Mac's `~/.oneterm/config.json`. Only plain `ssh [-t] [-p PORT] [-l USER] [-i KEY] HOST` connections are matched.

The hub runs in Docker. `deploy-hub.sh` copies it to the server and starts it; change the host name in that script and the allowed hosts in `hub/docker-compose.yml`. Put the same random token in the server's `~/docker/oneterm/.env` as `ONETERM_TOKEN` and in the Mac's `~/.oneterm/hub.json` as `{"url": "...", "token": "..."}`.

Agents started before setup don't have the hooks yet. Restart them, or run `/reload-all` in pi.

## Development

`src/` is the CLI, the Mac agent, and the hub; `support/agents.py` is the hook handler and the helper that runs on SSH hosts; `extension/` is the pi extension; `web/` is the page. State lives in `~/.oneterm` (or `$ONETERM_HOME`): `stash.json` is the list and `history.jsonl` logs every stash, restore, and delete.

Run `npm test`. For live tests, set `ONETERM_HOME` to a scratch directory and pass `--tabs` so you only touch throwaway tabs.
