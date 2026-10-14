#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Stash Ghostty Tabs
# @raycast.mode compact
# @raycast.icon 📥
# @raycast.packageName oneterm
# @raycast.description Save every Ghostty tab and pi session to oneterm and close them
# @raycast.author Colin Mason

exec "$HOME/.local/bin/oneterm" stash --all
