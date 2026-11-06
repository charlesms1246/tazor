#!/usr/bin/env zsh
# Dry run of scripts/demo-extras.sh on an anvil fork of Whitechain Sepolia with the real relayer pointed at it.
# A throwaway key is added as a signer of the real Priya ApproverAccount (impersonating the account), and the
# WB Soul mirror is handed to an anvil key, so every live entity keeps its real souls, roles and config.
# Touches nothing live.
set -u
setopt pipefail

ROOT=${0:A:h:h:h}
WC_UP=${WC_UP:-https://rpc.testnet.whitechain.io}
WC=http://127.0.0.1:8657
RELAYER_PORT=8797
OWNER=0xce4389ACb79463062c362fACB8CB04513fA3D8D8
MIRROR=0x9822650A99bD33F29E383345F570dAE1e4E00928
USDT=0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7
PRIYA=0x00aBed5bDddf794c415eE746d3E4De5332cC5450
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil dev key 0
RELAYER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d    # anvil dev key 1
PRIYA_KEY=$(cast keccak "tazor demo-extras dry-run priya")
DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
PRIYA_EOA=$(cast wallet address --private-key $PRIYA_KEY)

cleanup() { kill ${RELAYER_PID:-} ${WC_PID:-} 2>/dev/null }
trap cleanup EXIT INT TERM

anvil --fork-url $WC_UP --port 8657 --hardfork prague --silent & WC_PID=$!
for i in {1..60}; do cast chain-id -r $WC >/dev/null 2>&1 && break; sleep 1; done
print -r -- "fork up: Whitechain $(cast chain-id -r $WC) block $(cast block-number -r $WC)"

as() { local who=$1; shift; cast send "$@" --from $who --unlocked -r $WC >/dev/null || { print -u2 "setup failed: $*"; exit 1; } }
cast rpc anvil_impersonateAccount $OWNER -r $WC >/dev/null
cast rpc anvil_setBalance $OWNER 0x56BC75E2D63100000 -r $WC >/dev/null
as $OWNER $MIRROR "transferOwnership(address)" $DEPLOYER
as $OWNER $USDT "transfer(address,uint256)" $DEPLOYER 3000000

# the dry-run Priya key becomes a signer of the real Priya ApproverAccount (a self-call, so impersonate it)
bal=$(cast rpc eth_getBalance $PRIYA latest -r $WC | tr -d '"')
cast rpc anvil_impersonateAccount $PRIYA -r $WC >/dev/null
cast rpc anvil_setBalance $PRIYA 0xDE0B6B3A7640000 -r $WC >/dev/null
as $PRIYA $PRIYA "addSigners(bytes[])" "[$PRIYA_EOA]"
cast rpc anvil_stopImpersonatingAccount $PRIYA -r $WC >/dev/null
cast rpc anvil_setBalance $PRIYA $bal -r $WC >/dev/null

(cd $ROOT/apps/relayer && WC_RPC=$WC RELAYER_PRIVATE_KEY=$RELAYER_KEY PAYMASTER=0x5E1a26A8482641E7Cfa3FD6f454845C7Ae3C6686 PORT=$RELAYER_PORT \
  exec node --experimental-strip-types --disable-warning=ExperimentalWarning src/main.ts > /tmp/demo-extras-relayer.log 2>&1) & RELAYER_PID=$!
for i in {1..60}; do curl -fsS -m 2 http://127.0.0.1:$RELAYER_PORT/health >/dev/null 2>&1 && break; sleep 1; done
print -r -- "relayer up on :$RELAYER_PORT (log /tmp/demo-extras-relayer.log); deployer $DEPLOYER; Priya signer $PRIYA_EOA"

DRY_RUN=1 ENV_FILE=/dev/null WC_RPC=$WC RELAYER_URL=http://127.0.0.1:$RELAYER_PORT \
  DEPLOYER_KEY=$DEPLOYER_KEY PRIYA_KEY=$PRIYA_KEY RUN_JSON_DRY=${RUN_JSON_DRY:-} \
  zsh $ROOT/scripts/demo-extras.sh
