#!/bin/sh
# Resolve symlink to find the real bin directory
link="$(readlink "$0")"
if [ -n "$link" ]; then
  dir="$(cd "$(dirname "$0")" && cd "$(dirname "$link")" && pwd)"
else
  dir="$(cd "$(dirname "$0")" && pwd)"
fi
if command -v bun >/dev/null 2>&1; then
  exec bun "$dir/alchemy-effect.ts" "$@"
else
  exec node "$dir/alchemy-effect.js" "$@"
fi
