#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Stash Other Ghostty Tabs
# @raycast.mode compact
# @raycast.icon 📥
# @raycast.packageName oneterm
# @raycast.description Save every Ghostty tab except the front one to oneterm and close them
# @raycast.author Colin Mason

exec "$HOME/.local/bin/oneterm" stash --others
