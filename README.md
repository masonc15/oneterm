<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <img src=".github/assets/logo-light.svg" alt="oneterm" width="360">
  </picture>
</p>

<p align="center"><strong>OneTab for Ghostty.</strong></p>

One command saves your Ghostty tabs to a list and closes them, along with any pi, Claude Code, or Codex sessions running inside. You reopen them later one at a time instead of facing the whole pile again. Sessions on other machines over SSH work too.

<p align="center">
  <img src=".github/assets/screenshot.png" alt="The oneterm page, with stashed terminals grouped by stash time and links to restore or delete them" width="760">
</p>

## How it works

`oneterm stash` asks Ghostty for every open tab and checks what each terminal is running. For an idle shell, oneterm saves the working directory. For a pi, Claude Code, or Codex session, it saves the exact session ID, which the agent reports through a pi extension or lifecycle hooks. For an SSH session to a host you've set up, it saves the program running on that host, so restoring brings back the remote agent and not just `ssh host`. Other programs, such as an editor, a dev server, or an agent without the hooks, keep their tabs open, and oneterm tells you why.

oneterm doesn't kill busy agents. It lets the running tool call finish and saves its result, refuses new tool calls, and stops the agent before its next model request. The list marks that session "stopped mid-task", so say "continue" after you reopen it. If an agent can't reach a safe stop within two minutes, oneterm leaves its tab open.

To restore a session, oneterm opens a new tab in the saved directory and runs `pi --session <file>`, `claude --resume <id>`, or `codex --no-daemon resume <id>`. For a remote session, it runs that command over SSH. Terminals that shared a tab come back as splits in one tab.

## Usage

```sh
oneterm stash              # every tab
oneterm stash --others     # every tab but the front one
oneterm stash --this       # only the front tab
oneterm stash --dry-run    # list what would close and what would stay open
oneterm restore            # fzf picker. Tab selects several, Ctrl-D deletes
oneterm ls
oneterm open               # the web page
```

In pi, `/oneterm all`, `/oneterm others`, and `/oneterm this` do the same.

The web page is a OneTab-style list. A small hub on an always-on server serves it, so it works from your phone and while the Mac sleeps. Click an entry to reopen it, drag entries between groups, or delete them. If the Mac is offline, the hub holds your clicks and sends them when the Mac comes back. The hub only sends item IDs to the Mac, never commands.

When more than 6 tabs are open, a notification offers a "Stash all tabs" button. To change the limit, set `tabCap` in `~/.oneterm/config.json`, and set it to 0 to turn the notification off. `nudgeRepeatMinutes` sets how often the notification repeats.

## Setup

You need macOS, Ghostty 1.3 or later, Node 22.18 or later, Python 3.9 or later, fzf, and terminal-notifier. Clone the repo to `~/workspace/oneterm`, because the pi extension, the LaunchAgent, and the Raycast scripts expect that path.

```sh
ln -s ~/workspace/oneterm/bin/oneterm ~/.local/bin/oneterm
pi install ~/workspace/oneterm                 # pi extension
python3 support/agents.py --install            # Claude Code and Codex hooks
cp launchd/com.colin.oneterm-agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.colin.oneterm-agent.plist
cp raycast/*.sh ~/raycast/script-commands/     # optional Raycast commands
```

The hook installer adds its hooks to your existing `~/.claude/settings.json` and `~/.codex/hooks.json` and saves backups in `~/.oneterm/backups/`. Codex asks you once to trust the new hooks in `/hooks`. Codex also has to run with `--no-daemon`, because its shared background server hides which terminal a session belongs to. Add the flag to interactive `codex` calls in a shell wrapper.

For remote sessions, copy `support/agents.py` to `~/.oneterm/agents.py` on the server and run it there with `--install`. Then add the host to `remoteHosts` in `~/.oneterm/config.json` on the Mac. oneterm only matches plain `ssh [-t] [-p PORT] [-l USER] [-i KEY] HOST` connections.

The hub runs in Docker. `deploy-hub.sh` copies it to the server and starts it. Change the host name in that script and the allowed hosts in `hub/docker-compose.yml`. Then make a random token and put it in two places. On the server, it goes in `~/docker/oneterm/.env` as `ONETERM_TOKEN`. On the Mac, it goes in `~/.oneterm/hub.json`, which looks like `{"url": "...", "token": "..."}`.

Agents that started before setup don't have the hooks. Restart them, or run `/reload-all` in pi.

## Development

`src/` holds the CLI, the Mac agent, and the hub. `support/agents.py` is the hook handler and the helper that runs on SSH hosts. `extension/` is the pi extension, and `web/` is the page. oneterm keeps its state in `~/.oneterm`, or in `$ONETERM_HOME` if you set it. `stash.json` is the list, and `history.jsonl` logs every stash, restore, and delete.

Run `npm test`. For live tests, set `ONETERM_HOME` to a scratch directory and pass `--tabs` with the IDs of throwaway tabs.
