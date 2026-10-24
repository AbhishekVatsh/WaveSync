#!/bin/bash
# Builds dist/WaveSync-<version>.zip, the file to share with other people.
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' CSXS/manifest.xml)
OUT="dist/WaveSync"

rm -rf dist
mkdir -p "$OUT/extension"
cp -R CSXS js jsx index.html .debug "$OUT/extension/"
[ -d bin ] && cp -R bin "$OUT/extension/"

cp "packaging/Install WaveSync (Mac).command" "$OUT/"
chmod +x "$OUT/Install WaveSync (Mac).command"
# Windows wants CRLF line endings in .bat and .txt files.
tr -d '\r' < "packaging/Install WaveSync (Windows).bat" | sed 's/$/\r/' > "$OUT/Install WaveSync (Windows).bat"
tr -d '\r' < "packaging/READ ME FIRST.txt" | sed 's/$/\r/' > "$OUT/READ ME FIRST.txt"

(cd dist && ditto -c -k --keepParent --norsrc WaveSync "WaveSync-$VERSION.zip")
rm -rf "$OUT"
echo "Built dist/WaveSync-$VERSION.zip"
