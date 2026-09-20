#!/bin/sh
set -e

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="0.2.0"
REPOS="lurepos/herdr-commander lurepos/herdr-vscode-tasks"
BIN_NAME="herdr-commander"

# 1. Local compiled binary (release or debug)
if [ -x "$PLUGIN_DIR/target/release/$BIN_NAME" ]; then
    exec "$PLUGIN_DIR/target/release/$BIN_NAME" "$@"
fi

if [ -x "$PLUGIN_DIR/target/debug/$BIN_NAME" ]; then
    exec "$PLUGIN_DIR/target/debug/$BIN_NAME" "$@"
fi

# 2. Cached downloaded binary in plugin state directory
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/share/herdr/plugins/herdr.commander}"
mkdir -p "$STATE_DIR"
CACHED_BIN="$STATE_DIR/${BIN_NAME}-v$VERSION"

if [ -x "$CACHED_BIN" ]; then
    exec "$CACHED_BIN" "$@"
fi

# 3. Download precompiled binary from GitHub Releases
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64|amd64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2 ;;
esac

case "$OS" in
    linux) TARGET="${ARCH}-unknown-linux-gnu" ;;
    darwin) TARGET="${ARCH}-apple-darwin" ;;
    *) TARGET="" ;;
esac

if [ -n "$TARGET" ] && (command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1); then
    TMP_ARCHIVE="$STATE_DIR/${BIN_NAME}-$TARGET.tar.gz"

    for REPO in $REPOS; do
        URL="https://github.com/$REPO/releases/download/v$VERSION/${BIN_NAME}-$TARGET.tar.gz"
        echo "Attempting to download ${BIN_NAME} from $REPO ($TARGET)..." >&2

        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "$URL" -o "$TMP_ARCHIVE" 2>/dev/null || true
        else
            wget -q "$URL" -O "$TMP_ARCHIVE" 2>/dev/null || true
        fi

        if [ -f "$TMP_ARCHIVE" ] && [ -s "$TMP_ARCHIVE" ]; then
            tar -xzf "$TMP_ARCHIVE" -C "$STATE_DIR" 2>/dev/null || true
            rm -f "$TMP_ARCHIVE"
            if [ -f "$STATE_DIR/$BIN_NAME" ]; then
                mv -f "$STATE_DIR/$BIN_NAME" "$CACHED_BIN"
                chmod +x "$CACHED_BIN"
                exec "$CACHED_BIN" "$@"
            fi
        fi
    done
fi

# 4. Fallback to building locally with cargo if available
if command -v cargo >/dev/null 2>&1; then
    echo "Compiling herdr-commander with cargo..." >&2
    cargo build --release --manifest-path "$PLUGIN_DIR/Cargo.toml" >&2
    if [ -x "$PLUGIN_DIR/target/release/$BIN_NAME" ]; then
        exec "$PLUGIN_DIR/target/release/$BIN_NAME" "$@"
    fi
fi

echo "Error: Could not find or download herdr-commander executable." >&2
echo "Please ensure cargo is installed or download the binary from https://github.com/lurepos/herdr-commander/releases" >&2
exit 1
