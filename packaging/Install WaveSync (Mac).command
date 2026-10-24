#!/bin/bash
# Double-click to install the WaveSync panel for Adobe Premiere Pro (macOS).
cd "$(dirname "$0")"
SRC="$PWD/extension"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.wavesync.panel"

echo "Installing WaveSync for Premiere Pro..."
echo

if [ ! -f "$SRC/CSXS/manifest.xml" ]; then
  echo "Can't find the 'extension' folder next to this installer."
  echo "Unzip the whole WaveSync folder first, then run this again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

# WaveSync isn't signed by Adobe, so Premiere needs permission to load it.
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/" "$DEST/"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null

echo "Installed."
echo
if [ -x /opt/homebrew/bin/ffmpeg ] || [ -x /usr/local/bin/ffmpeg ] || [ -x "$DEST/bin/ffmpeg" ]; then
  echo "ffmpeg: found"
else
  echo "ffmpeg is missing. WaveSync needs it to read audio from your clips."
  echo "Install Homebrew from https://brew.sh, then run this in Terminal:"
  echo
  echo "    brew install ffmpeg"
fi
echo
echo "Restart Premiere Pro, then open:  Window > Extensions > WaveSync"
echo
read -n 1 -s -r -p "Press any key to close."
