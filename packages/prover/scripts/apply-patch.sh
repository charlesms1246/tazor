#!/bin/sh
set -e
cd "$(dirname "$0")/../vendor/unruggable-gateways"
if grep -q blockAccessListHash src/rlp.ts; then
  echo "rlp-glamsterdam.patch already applied"
else
  patch -p1 --forward --silent < ../../patches/rlp-glamsterdam.patch
  echo "applied rlp-glamsterdam.patch"
fi
