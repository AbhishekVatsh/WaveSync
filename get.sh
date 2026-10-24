#!/bin/bash
# WaveSync one-line installer for macOS:
#   curl -fsSL https://raw.githubusercontent.com/AbhishekVatsh/WaveSync/main/get.sh | bash
set -e
REPO="AbhishekVatsh/WaveSync"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.wavesync.panel"

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS. On Windows, use the PowerShell command from the README."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading WaveSync..."
curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP"
SRC="$TMP/WaveSync-main"

# WaveSync isn't signed by Adobe, so Premiere needs permission to load it.
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/CSXS" "$SRC/js" "$SRC/jsx" "$SRC/index.html" "$SRC/.debug" "$DEST/"
echo "Installed WaveSync to: $DEST"

if [ -x /opt/homebrew/bin/ffmpeg ] || [ -x /usr/local/bin/ffmpeg ]; then
  echo "ffmpeg: found"
elif command -v brew >/dev/null; then
  echo "Installing ffmpeg with Homebrew (WaveSync uses it to read audio)..."
  brew install ffmpeg
else
  echo
  echo "ffmpeg is missing. WaveSync needs it to read audio from your clips."
  echo "Install Homebrew from https://brew.sh, then run:  brew install ffmpeg"
fi

echo
echo "Done. Restart Premiere Pro, then open:  Window > Extensions > WaveSync"
