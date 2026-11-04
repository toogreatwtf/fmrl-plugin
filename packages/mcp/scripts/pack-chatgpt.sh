#!/usr/bin/env sh
# Zip plugins/fmrl-chatgpt for OpenAI's plugin portal, plugin.json at the
# archive root, README left out (it is notes for us, not the listing).
set -eu
root=$(cd "$(dirname "$0")/../../.." && pwd)
src="$root/plugins/fmrl-chatgpt"
version=$(node -p "require('$src/plugin.json').version")
out="$root/fmrl-chatgpt-$version.zip"
rm -f "$out"
cd "$src"
zip -qrX "$out" plugin.json mcp.json skills assets
echo "$out"
