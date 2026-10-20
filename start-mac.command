#!/bin/bash
cd "$(dirname "$0")"
# Finder-startede scripts får ikke Homebrews PATH med.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js mangler. Installer LTS-versionen fra https://nodejs.org og start igen."
  read -n 1 -s -r -p "Tryk en tast for at lukke..."
  exit 1
fi
node lol-helper.js
