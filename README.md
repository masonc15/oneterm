# oneterm

OneTab for Ghostty. One command saves every open Ghostty tab, including the pi session running in it, to a list and closes the tabs. Later you reopen them one at a time from that list instead of facing the whole pile again.

## How a stash works

`oneterm stash` asks Ghostty (through its AppleScript dictionary) for every tab and terminal, then looks at what each terminal's tty has in the foreground. An idle shell is saved as its working directory and an ssh session as its command line. A pi session is saved as its session file, which the bundled pi extension reports from inside pi. Tabs running anything else, like a dev server or an editor, stay open unless you pass `--force`; with it the command line is saved and typed back (not run) on restore.

Idle pi sessions close right away. A pi that is mid-task winds down at the next safe point. The tool call that is running finishes and its result lands in the session, tool calls that haven't started are skipped with a note to the model, and pi stops before its next model request. A pi waiting on a question (ask_user and friends) has the question cancelled. If a step is still running after two minutes it gets aborted. Either way, the list marks the session "stopped mid-task" and saying "continue" after resuming picks it up where it left off. Brand-new pi sessions with no messages are closed but not listed, the way OneTab skips blank tabs.

Restoring opens a new Ghostty tab in the saved directory and runs `pi --session <file>` (or ssh, or nothing for a shell). Terminals that shared a tab come back as splits in one tab. Restored items leave the list; everything that was ever stashed, restored, or deleted is logged in `~/.oneterm/history.jsonl`.

## Using it

```sh
oneterm stash              # every tab
oneterm stash --others     # everything but the front tab
oneterm stash --this       # just the front tab
oneterm stash --note "pick up after lunch"
oneterm stash --dry-run    # show what would happen
oneterm restore            # fzf picker; Tab selects several, Ctrl-D deletes
oneterm ls
oneterm open               # the web page
```

Inside pi, `/oneterm`, `/oneterm others`, and `/oneterm this` do the same for the tab you're in.

The web page lives on devbox at http://100.64.0.10:7317 (over Tailscale, so it works from the phone too) and stays up when this Mac is asleep or away. It is the OneTab-style view: groups by stash time, click a title to reopen it, "Restore all" and "Delete all" per group, and groups older than two weeks folded away. The header says whether the Mac is online.

The Mac stays the source of truth. `oneterm agent`, kept running by a LaunchAgent (`launchd/com.colin.oneterm-agent.plist`), pushes the stash to the hub whenever it changes and long-polls the hub for clicks. With the Mac online a restore opens the tab within a second. With it offline, deletes show right away and restores wait, marked "reopens when the Mac is back" with a cancel link, and run when the agent reconnects (they expire after a day). Stashing from the page needs the Mac online. The hub only ever passes item ids to the Mac, never commands, so nothing typed into the page can make the Mac run something it didn't save itself. The agent authenticates with a token in `~/.oneterm/hub.json`, the page rejects unknown Host headers, and writes need a custom header so other websites can't drive it.

When more than 6 Ghostty tabs are open, the agent posts a notification with a "Stash all tabs" button; clicking the notification itself opens the page. It nudges when the count goes over, again every 30 minutes while it stays over, and takes the notification down once you're back at 6 or fewer. The page shows the tab count in amber while you're over the limit. Change the cap or the repeat interval in `~/.oneterm/config.json`, for example `{"tabCap": 8, "nudgeRepeatMinutes": 60}`; a cap of 0 turns the nudge off. It needs terminal-notifier from Homebrew.

The `raycast/` scripts add "Stash Ghostty Tabs", "Stash Other Ghostty Tabs", and "Open oneterm" commands; give them hotkeys in Raycast.

## Install

Requires Ghostty 1.3+ (for AppleScript), Node 22.18+ (oneterm runs its TypeScript directly), and fzf for the picker.

```sh
pi install ~/workspace/oneterm                      # the pi extension
ln -s ~/workspace/oneterm/bin/oneterm ~/.local/bin/oneterm
cp raycast/*.sh ~/raycast/script-commands/
cp launchd/com.colin.oneterm-agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.colin.oneterm-agent.plist
./deploy-hub.sh                                      # the page on devbox
```

The hub and the agent share a token: `ONETERM_TOKEN` in devbox's `~/docker/oneterm/.env` and `{"url", "token"}` in `~/.oneterm/hub.json` here (both mode 600). `deploy-hub.sh` rsyncs `src/hub.ts`, `web/index.html` and the `hub/` Docker files to devbox and rebuilds; it never touches the hub's `data/` or `.env`.

pi sessions that were already running before the install don't have the extension yet and are left open by a stash; run `/reload-all` in any pi tab to load it everywhere.

## Files

Everything lives in `~/.oneterm`: `stash.json` is the list, `stash.md` is a readable copy of it, `live/` holds one file per running pi (pid to session file), and `requests/` and `acks/` are how the CLI and the pi extension hand off a stash. Set `ONETERM_HOME` to use another directory. The hub keeps its copy of the stash and the click queue in `~/docker/oneterm/data/hub.json` on devbox.
