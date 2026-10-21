#!/bin/bash
# Udgiver en ny version, som de installerede programmer selv finder ("Opdater nu" i vinduet).
# Kræver: VERSION i lol-helper.js er hævet, og repoet tvg-invest/lol-rune-helper findes på GitHub.
# Kør: bash scripts/build.sh && bash scripts/release.sh "Kort beskrivelse af ændringerne"
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "/const VERSION = '([^']+)'/.exec(require('fs').readFileSync('lol-helper.js','utf8'))[1]")"
NOTES="${1:-Ny version}"

# Stop før upload, hvis noget ikke passer - en binær med lavere VERSION end tagget ser tagget som nyt
# igen og giver brugerne en opdateringsløkke.
fail() { echo "STOP: $1" >&2; exit 1; }
[ -z "$(git status --porcelain -- lol-helper.js gui.html sea-config.json scripts)" ] || fail "uncommittede ændringer i kildekoden - commit først"
git fetch -q origin
[ -n "$(git branch -r --contains HEAD)" ] || fail "HEAD ($(git rev-parse --short HEAD)) er ikke pushet til GitHub - push først"
for f in dist/release/LoL-Rune-Helper.exe dist/release/LoL-Rune-Helper-mac dist/LoL-Rune-Helper-Windows.zip dist/LoL-Rune-Helper-Mac.zip; do
  [ -f "$f" ] || fail "$f mangler - kør bash scripts/build.sh"
done
for f in dist/release/LoL-Rune-Helper.exe dist/release/LoL-Rune-Helper-mac; do
  LC_ALL=C grep -q "const VERSION = '$VERSION';" "$f" || fail "$f er ikke bygget med VERSION $VERSION - kør bash scripts/build.sh igen"
  [ "$f" -nt lol-helper.js ] || fail "$f er ældre end lol-helper.js - kør bash scripts/build.sh igen"
done
gh release view "v$VERSION" --repo tvg-invest/lol-rune-helper >/dev/null 2>&1 && fail "v$VERSION findes allerede - hæv VERSION i lol-helper.js"

echo "Udgiver v$VERSION"
gh release create "v$VERSION" \
  --repo tvg-invest/lol-rune-helper \
  --target "$(git rev-parse HEAD)" \
  --title "LoL Rune Helper $VERSION" \
  --notes "$NOTES" \
  dist/release/LoL-Rune-Helper.exe \
  dist/release/LoL-Rune-Helper-mac \
  dist/LoL-Rune-Helper-Windows.zip \
  dist/LoL-Rune-Helper-Mac.zip
