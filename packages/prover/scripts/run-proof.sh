#!/bin/zsh
# End-to-end: Glamsterdam header check, fork deploy of ReverseOPVerifier on Whitechain Sepolia,
# proof of one Sepolia ENSv2 storage slot, and a tampered-proof negative check.
set -e
HERE=${0:A:h}; ROOT=$HERE/..; V=$ROOT/vendor/unruggable-gateways
WC=https://rpc.testnet.whitechain.io; PORT=8549; RPC=http://127.0.0.1:$PORT
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TARGET=${TARGET:-0x44007108C0Cca53498F19F259E73E70C2ebE900a}
SLOT=${SLOT:-0x7bf565dba35a82a82194edff4de4ef1347be714ed7d034ac92b4599367e91374}

$HERE/apply-patch.sh
(cd $ROOT && pnpm -s check:headers)

FORK=$(( $(cast block-number --rpc-url $WC) - 10 ))
anvil --fork-url $WC --fork-block-number $FORK --port $PORT --chain-id 1874 --silent &
APID=$!; trap "kill $APID" EXIT
until cast chain-id --rpc-url $RPC >/dev/null 2>&1; do sleep 0.3; done

cd $V
dep() { local out=$(forge create --rpc-url $RPC --private-key $KEY --broadcast "$@" 2>&1); local a=$(echo "$out" | awk '/Deployed to/{print $3}'); [[ -n $a ]] || { echo "$out" >&2; exit 1; }; echo $a; }
VM=$(dep contracts/GatewayVM.sol:GatewayVM)
HOOKS=$(dep contracts/eth/EthVerifierHooks.sol:EthVerifierHooks)
VER=$(dep contracts/op/ReverseOPVerifier.sol:ReverseOPVerifier --libraries contracts/GatewayVM.sol:GatewayVM:$VM \
  --constructor-args '[]' 7200 $HOOKS 0x4200000000000000000000000000000000000015)
echo "fork=$FORK GatewayVM=$VM hooks=$HOOKS verifier=$VER"
bun $HERE/prove-slot.ts $RPC $VER $FORK $TARGET $SLOT
