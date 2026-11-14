#!/bin/sh
# Sync the GUI mod from this repo to the Windows herdr-app home (WSL dev loop).
# Usage: scripts/sync-mod.sh [check]
set -e
DEST="${HERDR_APP_HOME_WIN:-/mnt/c/Users/general/.config/herdr-app}"
SRC="$(dirname "$0")/../mods/commander-gui"
EXE="/mnt/c/Users/general/AppData/Local/Programs/herdr-app/herdr-app.exe"

mkdir -p "$DEST/mods/commander-gui"
cp "$SRC/main.js" "$SRC/discover.js" "$SRC/mod.json" "$DEST/mods/commander-gui/"
echo "synced -> $DEST/mods/commander-gui (hot reload applies in ~1s)"

if [ "${1:-}" = "check" ] && [ -x "$EXE" ]; then
  "$EXE" check 'C:\Users\general\.config\herdr-app\mods\commander-gui'
fi
