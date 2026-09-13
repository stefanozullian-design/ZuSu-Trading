#!/usr/bin/env bash
# Double-click equivalent for macOS and Linux. The Windows launcher is
# start-zusu.cmd; both do the same thing and both defer to scripts/start.mjs.
set -e
cd "$(dirname "$0")"
exec node scripts/start.mjs
