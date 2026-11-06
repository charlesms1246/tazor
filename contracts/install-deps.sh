#!/bin/sh
# Reinstalls the pinned Solidity dependencies into lib/ (lib/ is not committed).
set -e
cd "$(dirname "$0")"
forge install foundry-rs/forge-std@v1.17.0 --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.5.0 --no-git
forge install OpenZeppelin/openzeppelin-community-contracts@a12b30ca7affe3320777378eddf2d0cebae8c5b2 --no-git
