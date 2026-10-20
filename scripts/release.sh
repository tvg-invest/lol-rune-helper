#!/bin/bash
# Udgiver en ny version, som de installerede programmer selv finder ("Opdater nu" i vinduet).
# Kræver: VERSION i lol-helper.js er hævet, og repoet tvg-invest/lol-rune-helper findes på GitHub.
# Kør: bash scripts/build.sh && bash scripts/release.sh "Kort beskrivelse af ændringerne"
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "/const VERSION = '([^']+)'/.exec(require('fs').readFileSync('lol-helper.js','utf8'))[1]")"
NOTES="${1:-Ny version}"
echo "Udgiver v$VERSION"
gh release create "v$VERSION" \
  --repo tvg-invest/lol-rune-helper \
  --title "LoL Rune Helper $VERSION" \
  --notes "$NOTES" \
  dist/release/LoL-Rune-Helper.exe \
  dist/release/LoL-Rune-Helper-mac \
  dist/LoL-Rune-Helper-Windows.zip \
  dist/LoL-Rune-Helper-Mac.zip
