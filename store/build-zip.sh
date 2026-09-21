#!/usr/bin/env bash
# Builds the Chrome Web Store upload: the extension without "key" (the store
# assigns its own) and without repo-only files. Usage: store/build-zip.sh out.zip
set -euo pipefail
out="$(realpath -m "${1:-dist/speakr-recorder.zip}")"
root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cd "$root"
cp -r *.js *.html *.css icons helper "$stage"/
jq 'del(.key)' manifest.json > "$stage/manifest.json"
mkdir -p "$(dirname "$out")"
rm -f "$out"
(cd "$stage" && python3 -m zipfile -c "$out" ./*)
echo "Built $out ($(du -h "$out" | cut -f1))"
