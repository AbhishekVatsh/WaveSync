#!/bin/bash
# Installs the WaveSync panel for Premiere Pro (macOS). Run: bash install.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.wavesync.panel"

# Unsigned panels need CEP debug mode.
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/CSXS" "$SRC/js" "$SRC/jsx" "$SRC/index.html" "$SRC/.debug" "$DEST/"
[ -d "$SRC/bin" ] && cp -R "$SRC/bin" "$DEST/"

echo "Installed to: $DEST"
if command -v ffmpeg >/dev/null || [ -x /opt/homebrew/bin/ffmpeg ] || [ -x /usr/local/bin/ffmpeg ] || [ -x "$DEST/bin/ffmpeg" ]; then
  echo "ffmpeg: found"
else
  echo "ffmpeg: NOT found. Install it with:  brew install ffmpeg"
fi
echo "Restart Premiere Pro, then open Window > Extensions > WaveSync."
