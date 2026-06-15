#!/usr/bin/env bash
set -euo pipefail

echo "Douyin Creator Archiver bootstrap check"

node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "$node_major" -lt 22 ]; then
  echo "ERR node: Node.js 22.5+ required"
  exit 1
fi
echo "OK node: $(node -v)"

if [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "ERR chrome: install Google Chrome for macOS"
  exit 1
fi
echo "OK chrome"

if [ ! -x "/opt/homebrew/bin/ffmpeg" ]; then
  echo "ERR ffmpeg: install with 'brew install ffmpeg'"
  exit 1
fi
echo "OK ffmpeg"

npm test
echo "OK bootstrap"

