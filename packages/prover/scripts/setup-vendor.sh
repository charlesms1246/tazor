#!/bin/sh
# Fetches Unruggable Gateways at the pinned commit into vendor/ (not committed) and applies the patch.
set -e
cd "$(dirname "$0")/.."
V=vendor/unruggable-gateways
if [ ! -d "$V/.git" ]; then
  git clone https://github.com/unruggable-labs/unruggable-gateways "$V"
fi
(cd "$V" && git checkout -q 7426ac57509e2023a673956439eed29998d2e371 && git submodule update --init --recursive && bun install && forge build)
sh scripts/apply-patch.sh
