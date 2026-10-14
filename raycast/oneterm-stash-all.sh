#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Stash Ghostty Tabs
# @raycast.mode compact
# @raycast.icon 📥
# @raycast.packageName oneterm
# @raycast.description Stash every Ghostty tab and the agents running in them
# @raycast.author Colin Mason

exec "$HOME/.local/bin/oneterm" stash --all
