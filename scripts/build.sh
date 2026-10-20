#!/bin/bash
# Bygger færdige programfiler (ingen Node-installation nødvendig) med Node "single executable applications".
#   dist/LoL-Rune-Helper-Windows.zip  ->  LoL Rune Helper.exe
#   dist/LoL-Rune-Helper-Mac.zip      ->  LoL Rune Helper (universal: Apple Silicon + Intel)
# Kør fra macOS: bash scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="$(node -p 'process.versions.node')"   # blob og binær skal være samme Node-version
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
DIST=dist
CACHE="$DIST/cache/v$NODE_VERSION"
mkdir -p "$CACHE"

fetch() { # url dest
  [ -f "$2" ] || { echo "Henter $1"; curl -fsSL "$1" -o "$2.tmp" && mv "$2.tmp" "$2"; }
}

# 1) Officielle Node-binærer
fetch "https://nodejs.org/dist/v$NODE_VERSION/win-x64/node.exe" "$CACHE/node.exe"
for arch in arm64 x64; do
  if [ ! -f "$CACHE/node-darwin-$arch" ]; then
    fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$arch.tar.gz" "$CACHE/darwin-$arch.tar.gz"
    tar -xzf "$CACHE/darwin-$arch.tar.gz" -C "$CACHE" "node-v$NODE_VERSION-darwin-$arch/bin/node"
    mv "$CACHE/node-v$NODE_VERSION-darwin-$arch/bin/node" "$CACHE/node-darwin-$arch"
    rm -rf "$CACHE/node-v$NODE_VERSION-darwin-$arch" "$CACHE/darwin-$arch.tar.gz"
  fi
done

# 2) Program-blob (lol-helper.js + gui.html)
node --experimental-sea-config sea-config.json

POSTJECT="npx --yes postject@1.0.0-alpha.6"
WIN="$DIST/LoL-Rune-Helper-Windows"
MAC="$DIST/LoL-Rune-Helper-Mac"
rm -rf "$WIN" "$MAC" "$DIST"/*.zip
mkdir -p "$WIN" "$MAC"

# 3) Windows
cp "$CACHE/node.exe" "$WIN/LoL Rune Helper.exe"
node scripts/strip-authenticode.js "$WIN/LoL Rune Helper.exe"
$POSTJECT "$WIN/LoL Rune Helper.exe" NODE_SEA_BLOB "$DIST/sea-prep.blob" --sentinel-fuse "$FUSE"

# 4) macOS: injicér pr. arkitektur, saml til universal-fil, ad-hoc-signér
for arch in arm64 x64; do
  cp "$CACHE/node-darwin-$arch" "$DIST/mac-$arch"
  codesign --remove-signature "$DIST/mac-$arch"
  $POSTJECT "$DIST/mac-$arch" NODE_SEA_BLOB "$DIST/sea-prep.blob" --sentinel-fuse "$FUSE" --macho-segment-name NODE_SEA
done
lipo -create "$DIST/mac-arm64" "$DIST/mac-x64" -output "$MAC/LoL Rune Helper"
rm "$DIST/mac-arm64" "$DIST/mac-x64"
codesign --sign - --force "$MAC/LoL Rune Helper"
chmod +x "$MAC/LoL Rune Helper"

# 5) Pak med config + vejledning
for dir in "$WIN" "$MAC"; do
  cp config.json "$dir/"
  cp LAES-MIG.txt "$dir/LÆS MIG.txt"
done
(cd "$DIST" && zip -qry LoL-Rune-Helper-Windows.zip LoL-Rune-Helper-Windows && zip -qry LoL-Rune-Helper-Mac.zip LoL-Rune-Helper-Mac)

# 6) Rå programfiler til automatiske opdateringer (navne som programmet leder efter i udgivelsen)
mkdir -p "$DIST/release"
cp "$WIN/LoL Rune Helper.exe" "$DIST/release/LoL-Rune-Helper.exe"
cp "$MAC/LoL Rune Helper" "$DIST/release/LoL-Rune-Helper-mac"
ls -lh "$DIST"/*.zip
