<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <img src=".github/assets/logo-light.svg" alt="oneterm" width="360">
  </picture>
</p>

<p align="center"><strong>OneTab for Ghostty.</strong></p>

oneterm saves your [Ghostty](https://ghostty.org) tabs to a list and closes them, including any [pi](https://pi.dev), [Claude Code](https://code.claude.com/docs/en/overview), or [Codex](https://developers.openai.com/codex/cli) sessions running in them. Then you can bring them back one at a time when you actually need them, instead of staring at 15 tabs. It works for sessions on other machines over SSH too.

<p align="center">
  <img src=".github/assets/screenshot.png" alt="The oneterm page, with stashed terminals grouped by stash time and links to restore or delete them" width="760">
</p>

## How it works

When you run `oneterm stash`, it asks Ghostty for every open tab through its [AppleScript interface](https://ghostty.org/docs/features/applescript) and checks what's running in each one. An idle shell gets saved as its working directory. A pi, Claude Code, or Codex session gets saved by its exact session ID, which the agent reports itself through a pi extension or lifecycle hooks. If a tab is SSHed into a host you've set up, oneterm looks at what's running on that host, so restoring it brings back the remote agent itself. Anything else, like an editor, a dev server, or an agent without the hooks, stays open, and oneterm tells you why.

It won't kill an agent in the middle of something. The tool call that's running gets to finish and its result is saved, any new tool calls get refused, and the agent stops before it talks to the model again. That session shows up as "stopped mid-task", so just say "continue" when you reopen it. If an agent can't get to a safe stopping point within two minutes, oneterm leaves its tab alone.

Restoring opens a new tab in the saved directory and runs `pi --session <file>`, `claude --resume <id>`, or `codex --no-daemon resume <id>`, over SSH if the session was remote. Terminals that shared a tab come back as splits.

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

In pi, `/oneterm all`, `/oneterm others`, and `/oneterm this` do the same thing.

There's also a [OneTab](https://www.one-tab.com)-style web page. A small hub on an always-on server serves it, so you can get to it from your phone or while your Mac is asleep. Click something to reopen it, drag things between groups, or delete them. If the Mac is offline, the hub holds onto your clicks and sends them once it's back. The hub only ever sends the Mac item IDs, so nothing typed into the page can make your Mac run a command.

Once you have more than 6 tabs open, you'll get a notification with a "Stash all tabs" button. You can change the limit with `tabCap` in `~/.oneterm/config.json`, or set it to 0 to turn the notification off. `nudgeRepeatMinutes` controls how often it reminds you.

## Setup

You'll need macOS, Ghostty 1.3 or later, Node 22.18 or later, Python 3.9 or later, [fzf](https://github.com/junegunn/fzf#installation), and [terminal-notifier](https://github.com/julienXX/terminal-notifier). Clone the repo to `~/workspace/oneterm`, because the pi extension, the LaunchAgent, and the [Raycast scripts](https://github.com/raycast/script-commands) all expect it there.

```sh
ln -s ~/workspace/oneterm/bin/oneterm ~/.local/bin/oneterm
pi install ~/workspace/oneterm                 # pi extension
python3 support/agents.py --install            # Claude Code and Codex hooks
cp launchd/com.colin.oneterm-agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.colin.oneterm-agent.plist
cp raycast/*.sh ~/raycast/script-commands/     # optional Raycast commands
```

The hook installer adds the [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [Codex hooks](https://developers.openai.com/codex/hooks) to your existing `~/.claude/settings.json` and `~/.codex/hooks.json`, and it backs both files up to `~/.oneterm/backups/` first. Codex will ask you to trust the new hooks once in `/hooks`. Codex also has to run with `--no-daemon`, because its shared background server makes it impossible to tell which terminal a session belongs to. The easiest fix is a shell wrapper that adds the flag to interactive `codex` calls.

For remote sessions, copy `support/agents.py` to `~/.oneterm/agents.py` on the server and run it there with `--install`. Then add the host to `remoteHosts` in `~/.oneterm/config.json` on your Mac. Right now oneterm only matches plain `ssh [-t] [-p PORT] [-l USER] [-i KEY] HOST` connections.

The hub runs in Docker, and `deploy-hub.sh` copies it to your server and starts it. You'll have to change the host name in that script and the allowed hosts in `hub/docker-compose.yml`. Then make a random token and put it in two places: `~/docker/oneterm/.env` on the server as `ONETERM_TOKEN`, and `~/.oneterm/hub.json` on your Mac as `{"url": "...", "token": "..."}`.

Agents you started before setting this up won't have the hooks yet, so restart them, or run `/reload-all` in pi.

## Development

`src/` has the CLI, the Mac agent, and the hub. `support/agents.py` is the hook handler, and it's also the helper that runs on SSH hosts. `extension/` is the pi extension, and `web/` is the page. State lives in `~/.oneterm`, or `$ONETERM_HOME` if you set it. `stash.json` is the list, and `history.jsonl` logs every stash, restore, and delete.

Run `npm test` for the tests. For live testing, point `ONETERM_HOME` at a scratch directory and pass `--tabs` with the IDs of throwaway tabs, so you don't stash your real ones.
