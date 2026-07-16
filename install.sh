#!/usr/bin/env bash
# Launcher for the Dojo Bay installer. Double-clickable on a desktop (see
# dojobay-install.desktop) and equally happy headless: ./install.sh over SSH.
set -e
cd "$(dirname "$0")"
if [ "$(id -u)" -ne 0 ]; then
  exec sudo node scripts/install.mjs "$@"
fi
exec node scripts/install.mjs "$@"
