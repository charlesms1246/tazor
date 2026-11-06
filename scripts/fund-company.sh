#!/usr/bin/env zsh
# Tops up a demo company account with test USDT from the deployer, TESTNET ONLY (Whitechain Sepolia).
# Usage:   zsh scripts/fund-company.sh <amount USDT> [acme|acme-v1|bluejay]
#          DRY_RUN=1 zsh scripts/fund-company.sh 5          # reads only
# Keys come only from the environment (never printed); sources $ENV_FILE (default tazor/.env.local):
#   PRIVATE_KEY (or DEPLOYER_KEY). Overrides: WC_RPC, ACCOUNT (any company account), MAX_USDT (default 100).
set -u
setopt pipefail

ROOT=${0:A:h:h}
ENV_FILE=${ENV_FILE:-$ROOT/.env.local}
if [[ -f $ENV_FILE ]]; then set -a; source $ENV_FILE; set +a; fi
for bin in cast jq; do command -v $bin >/dev/null || { print -u2 "missing dependency: $bin"; exit 2; }; done

AMOUNT=${1:-}
COMPANY=${2:-acme}
[[ $AMOUNT =~ '^[0-9]+(\.[0-9]{1,6})?$' ]] || { print -u2 "usage: zsh scripts/fund-company.sh <amount USDT> [acme|acme-v1|bluejay]"; exit 2; }
DRY_RUN=${DRY_RUN:-0}
WC_RPC=${WC_RPC:-https://rpc.testnet.whitechain.io}
MAX_USDT=${MAX_USDT:-100}
USDT=$(jq -r '.USDT' $ROOT/contracts/deployments/1874.json)

case $COMPANY in
  acme)    DEFAULT=0xb99A12652BEe98429ae31EA0529A0b63f1073721 ;;   # acme-p2, the account the app shows
  acme-v1) DEFAULT=0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6 ;;
  bluejay) DEFAULT=0xc1dce946D192e344251972470237F1471C93876c ;;
  *) [[ -n ${ACCOUNT:-} ]] || { print -u2 "unknown company '$COMPANY': use acme, acme-v1 or bluejay, or set ACCOUNT"; exit 2; } ;;
esac
TO=$(cast to-check-sum-address ${ACCOUNT:-$DEFAULT})

hexkey() { [[ -n ${1:-} ]] && print -r -- "0x${1#0x}" }
KEY=$(hexkey ${DEPLOYER_KEY:-${PRIVATE_KEY:-}})
if [[ -n $KEY ]]; then FROM=$(cast wallet address --private-key $KEY)
elif [[ $DRY_RUN == 1 ]]; then FROM=${DEPLOYER_ADDRESS:-0xce4389ACb79463062c362fACB8CB04513fA3D8D8}
else print -u2 "PRIVATE_KEY (or DEPLOYER_KEY) is not set (env or $ENV_FILE)"; exit 2; fi

fail() { print -r -- "FAIL  $*"; exit 1 }
[[ $(cast chain-id -r $WC_RPC) == 1874 ]] || fail "WC_RPC is not Whitechain Sepolia (1874)"
[[ $(cast code $TO -r $WC_RPC) != 0x ]] || fail "$TO has no code; is it a company account?"
BASE=$(cast parse-units $AMOUNT 6)
MAX=$(cast parse-units $MAX_USDT 6)
(( BASE > 0 && BASE <= MAX )) || fail "amount must be above 0 and at most $MAX_USDT USDT (set MAX_USDT to raise)"
bal() { cast call $USDT "balanceOf(address)(uint256)" $1 -r $WC_RPC | awk '{print $1}' }
have=$(bal $FROM)
(( have >= BASE )) || fail "deployer $FROM holds $(cast format-units $have 6) USDT, less than $AMOUNT"
before=$(bal $TO)
print -r -- "fund $COMPANY $TO with $AMOUNT USDT from $FROM (company now $(cast format-units $before 6) USDT)"

if [[ $DRY_RUN == 1 ]]; then
  print -r -- "DRY RUN would send on whitechain: $USDT transfer(address,uint256)  calldata $(cast calldata 'transfer(address,uint256)' $TO $BASE)"
  print -r -- "RESULT: PASS (dry run: nothing was sent)"; exit 0
fi
NONCE=$(cast nonce $FROM --block pending -r $WC_RPC)
out=$(cast send $USDT "transfer(address,uint256)" $TO $BASE --nonce $NONCE --private-key $KEY -r $WC_RPC --json 2>&1) || fail "transfer failed: ${out[1,300]}"
tx=$(print -r -- $out | jq -r .transactionHash)
[[ $(print -r -- $out | jq -r .status) == 0x1 ]] || fail "transfer reverted: $tx"
after=$(bal $TO)
print -r -- "tx https://explorer.testnet.whitechain.io/tx/$tx"
print -r -- "company balance $(cast format-units $before 6) -> $(cast format-units $after 6) USDT"
print -r -- "RESULT: PASS"
