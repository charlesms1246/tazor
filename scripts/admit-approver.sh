#!/usr/bin/env zsh
# Admits a new approver (for example a phone's passkey ApproverAccount from /onboard/) to a demo company, TESTNET ONLY:
#   1. deploys the ApproverAccount through the relayer's POST /approver if it has no code yet (needs SIGNER);
#   2. registers a Soul for it in the WB Soul MIRROR and sets IsVerified (simulated KYC, not WhiteBIT);
#   3. grants APPROVER (1<<64) on the company's ENS registry on Ethereum Sepolia (grantRootRoles);
#   4. asks the relayer's POST /sync until the role is cached on Whitechain (it waits out pending-l1);
#   5. checks the result and that the account is not on a RevocationList.
#
# Usage:   SIGNER=0x… zsh scripts/admit-approver.sh <approverAccount> [acme|bluejay]
#          DRY_RUN=1 zsh scripts/admit-approver.sh <approverAccount> [company]   # reads only, prints each tx it would send
# Keys come only from the environment (never printed); sources $ENV_FILE (default tazor/.env.local) if present:
#   PRIVATE_KEY (or DEPLOYER_KEY): owner of the WB Soul mirror and an APPROVER admin on the company registry.
# Overrides: WC_RPC, SEPOLIA_RPC (default tenderly), RELAYER_URL (default https://tazor-relayer.vercel.app), REGISTRY, RUN_JSON.
# Needs: cast, jq, curl, python3. cast takes the key via --private-key, so it appears briefly in the local process list.
set -u
setopt pipefail

ROOT=${0:A:h:h}
ENV_FILE=${ENV_FILE:-$ROOT/.env.local}
if [[ -f $ENV_FILE ]]; then set -a; source $ENV_FILE; set +a; fi
for bin in cast jq curl python3; do command -v $bin >/dev/null || { print -u2 "missing dependency: $bin"; exit 2; }; done

ACCOUNT_IN=${1:-}
COMPANY=${2:-acme}
[[ $ACCOUNT_IN =~ '^0x[0-9a-fA-F]{40}$' ]] || { print -u2 "usage: SIGNER=0x… zsh scripts/admit-approver.sh <approverAccount> [acme|bluejay]"; exit 2; }
ACCOUNT=$(cast to-check-sum-address $ACCOUNT_IN)
SIGNER=${SIGNER:-}
[[ -z $SIGNER || $SIGNER =~ '^0x[0-9a-fA-F]+$' ]] || { print -u2 "SIGNER must be hex"; exit 2; }

DRY_RUN=${DRY_RUN:-0}
WC_RPC=${WC_RPC:-https://rpc.testnet.whitechain.io}
SEPOLIA_RPC=${SEPOLIA_RPC:-https://sepolia.gateway.tenderly.co}
RELAYER_URL=${RELAYER_URL:-https://tazor-relayer.vercel.app}
RELAYER_URL=${RELAYER_URL%/}
WC_TX=https://explorer.testnet.whitechain.io/tx
SEP_TX=https://sepolia.etherscan.io/tx
WC_JSON=$ROOT/contracts/deployments/1874.json
jqa() { jq -r "$2 // empty" $1 }

case $COMPANY in
  acme)    DEFAULT_REGISTRY=0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1; COMPANY_ACCOUNTS=(0xb99A12652BEe98429ae31EA0529A0b63f1073721 0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6) ;;
  bluejay) DEFAULT_REGISTRY=0x2A582b9cFD4C20921C467512B7ebA41204d9a16b; COMPANY_ACCOUNTS=(0xc1dce946D192e344251972470237F1471C93876c) ;;
  *) [[ -n ${REGISTRY:-} ]] || { print -u2 "unknown company '$COMPANY': use acme or bluejay, or set REGISTRY"; exit 2; }; COMPANY_ACCOUNTS=() ;;
esac
REGISTRY=$(cast to-check-sum-address ${REGISTRY:-$DEFAULT_REGISTRY})

MIRROR=$(jqa $WC_JSON .WBSoulMirror)
FACTORY=$(jqa $WC_JSON .ApproverAccountFactory)
ROLE_CACHE=$(jqa $WC_JSON .RoleCache)
LIST1=$(jqa $WC_JSON .RevocationList)
LIST2=$(jqa $WC_JSON .RevocationListV2)
IS_VERIFIED=0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41
VERIFIED=0x0000000000000000000000000000000000000001
ROLE_APPROVER=$(cast to-dec 0x10000000000000000)

hexkey() { [[ -n ${1:-} ]] && print -r -- "0x${1#0x}" }
DEPLOYER_KEY=$(hexkey ${DEPLOYER_KEY:-${PRIVATE_KEY:-}})
if [[ -n $DEPLOYER_KEY ]]; then
  DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
elif [[ $DRY_RUN == 1 ]]; then
  DEPLOYER=${DEPLOYER_ADDRESS:-0xce4389ACb79463062c362fACB8CB04513fA3D8D8}
else
  print -u2 "PRIVATE_KEY (or DEPLOYER_KEY) is not set (env or $ENV_FILE)"; exit 2
fi

# ---- reporting

RUN_JSON=${RUN_JSON:-$ROOT/scripts/admit/last-run.json}
[[ $DRY_RUN == 1 ]] && RUN_JSON=
typeset -a SUMMARY
STEP=0
step() { STEP=$1; print; print -r -- "== STEP $1: $2" }
info() { print -r -- "   $*" }
pass() { print -r -- "STEP $STEP PASS  $([[ $DRY_RUN == 1 ]] && print '[dry run, nothing sent] ')$*" }
print_summary() {
  print; print -r -- "== Summary  ($COMPANY, approver $ACCOUNT)"
  (( ${#SUMMARY} )) || { print -r -- "   no transactions sent"; return }
  for r in $SUMMARY; do print -r -- "   $r"; done
}
die() { print -r -- "STEP $STEP FAIL  $*"; print_summary; print; print -r -- "RESULT: FAIL"; exit 1 }
record() {   # <chain> <label> <hash>
  local url=$([[ $1 == sepolia ]] && print $SEP_TX || print $WC_TX)/$3
  SUMMARY+=("step $STEP  $2  $url")
  [[ -n $RUN_JSON && -f $RUN_JSON ]] || return 0
  jq --argjson step $STEP --arg chain $1 --arg label "$2" --arg hash $3 '.txs += [{step: $step, label: $label, chain: $chain, hash: $hash}]' \
    $RUN_JSON > $RUN_JSON.tmp && mv $RUN_JSON.tmp $RUN_JSON
}
if [[ -n $RUN_JSON ]]; then
  mkdir -p ${RUN_JSON:h}
  jq -n --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg company $COMPANY --arg account $ACCOUNT --arg registry $REGISTRY --arg relayer $RELAYER_URL \
    '{startedAt: $started, company: $company, account: $account, registry: $registry, relayer: $relayer, txs: []}' > $RUN_JSON
fi

# ---- chain helpers (explicit sequential nonces per chain)

has_bit() { python3 -c "import sys; sys.exit(0 if (int('$1', 0) >> $2) & 1 else 1)" }   # <uint> <bit>
first() { awk '{print $1}' }
typeset -A NONCE
next_nonce() {   # <chain> <rpc> -> NONCE_OUT
  if [[ -z ${NONCE[$1]:-} ]]; then NONCE[$1]=$(cast nonce $DEPLOYER --block pending -r $2); else NONCE[$1]=$(( NONCE[$1] + 1 )); fi
  NONCE_OUT=${NONCE[$1]}
}
send() {   # <chain> <label> <to> <sig> [args...] -> LAST_TX
  local chain=$1 label=$2 to=$3; shift 3
  local rpc=$([[ $chain == sepolia ]] && print $SEPOLIA_RPC || print $WC_RPC)
  if [[ $DRY_RUN == 1 ]]; then
    info "DRY RUN would send on $chain: $to $1  calldata $(cast calldata "$@")"
    LAST_TX=; return 0
  fi
  next_nonce $chain $rpc
  local out
  out=$(cast send $to "$@" --nonce $NONCE_OUT --private-key $DEPLOYER_KEY -r $rpc --json 2>&1) || die "$label failed: ${out[1,300]}"
  LAST_TX=$(print -r -- $out | jq -r .transactionHash)
  [[ $(print -r -- $out | jq -r .status) == 0x1 ]] || die "$label reverted: $LAST_TX"
  LAST_BLOCK=$(cast to-dec $(print -r -- $out | jq -r .blockNumber))
  record $chain "$label" $LAST_TX
  info "$label  $([[ $chain == sepolia ]] && print $SEP_TX || print $WC_TX)/$LAST_TX"
}
mirror_send() {   # <label> <sig> [args...]: a mirror write, direct or through MirrorOperator.execute
  local label=$1 sig=$2; shift 2
  if [[ -n $MIRROR_VIA ]]; then send whitechain "$label via MirrorOperator" $MIRROR_VIA "execute(bytes)" $(cast calldata "$sig" "$@")
  else send whitechain "$label" $MIRROR "$sig" "$@"; fi
}
relayer() {   # <path> <json> -> RELAYER_BODY, RELAYER_STATUS
  local out
  out=$(curl -sS -m 120 -X POST "$RELAYER_URL$1" -H 'content-type: application/json' -d "$2" -w '\n%{http_code}' 2>&1) || die "relayer $1 unreachable at $RELAYER_URL: ${out[1,200]}"
  RELAYER_STATUS=${out##*$'\n'}
  RELAYER_BODY=${out%$'\n'*}
}

print -r -- "Tazor: admit approver $ACCOUNT to $COMPANY (registry $REGISTRY)$([[ $DRY_RUN == 1 ]] && print '  DRY RUN')"

# ---- 0: preflight

step 0 "preflight (testnet only)"
[[ $(cast chain-id -r $WC_RPC) == 1874 ]] || die "WC_RPC is not Whitechain Sepolia (1874)"
[[ $(cast chain-id -r $SEPOLIA_RPC) == 11155111 ]] || die "SEPOLIA_RPC is not Ethereum Sepolia (11155111)"
[[ -n $MIRROR && -n $FACTORY && -n $ROLE_CACHE ]] || die "missing addresses in $WC_JSON"
owner=$(cast call $MIRROR "owner()(address)" -r $WC_RPC)
# the mirror is owned by the deployer, or (after setup-sandbox.sh) by a MirrorOperator the deployer owns: then writes go through execute(bytes)
MIRROR_VIA=""
if [[ ${owner:l} != ${DEPLOYER:l} ]]; then
  op_owner=$(cast call $owner "owner()(address)" -r $WC_RPC 2>/dev/null)
  [[ ${op_owner:l} == ${DEPLOYER:l} ]] || die "deployer $DEPLOYER does not own the WB Soul mirror ($owner) nor its MirrorOperator"
  MIRROR_VIA=$owner
  info "WB Soul mirror is owned by MirrorOperator $owner (owned by the deployer); writing through execute(bytes)"
fi
droles=$(cast call $REGISTRY "roles(uint256,address)(uint256)" 0 $DEPLOYER -r $SEPOLIA_RPC | first)
has_bit $droles 192 || die "deployer $DEPLOYER is not an APPROVER admin on $REGISTRY"
info "deployer $DEPLOYER: $(cast balance $DEPLOYER --ether -r $WC_RPC) WBT, $(cast balance $DEPLOYER --ether -r $SEPOLIA_RPC) Sepolia ETH"
health=$(curl -sS -m 30 $RELAYER_URL/health) || die "relayer unreachable at $RELAYER_URL"
print -r -- $health | jq -e --arg r ${REGISTRY:l} '[.watchRegistries[]? | ascii_downcase] | index($r) != null' >/dev/null \
  || die "relayer $RELAYER_URL does not watch $REGISTRY (add it to WATCH_REGISTRIES)"
for c in $COMPANY_ACCOUNTS; do
  for l in $LIST1 $LIST2; do
    [[ $(cast call $l "isRevoked(address,address)(bool)" $c $ACCOUNT -r $WC_RPC) == true ]] && die "$ACCOUNT is on RevocationList $l for $c; revocations are final, create a new passkey on /onboard/"
  done
done
pass "testnets, mirror owner, ENS admin and relayer ok; not revoked"

# ---- 1: approver account deployed

step 1 "approver account deployed on Whitechain"
code=$(cast code $ACCOUNT -r $WC_RPC)
if [[ $code != 0x ]]; then
  pass "already deployed"
else
  [[ -n $SIGNER ]] || die "$ACCOUNT has no code; pass SIGNER=0x… (shown on /onboard/) so the relayer can deploy it"
  predicted=$(cast call $FACTORY "predictAddress(bytes[])(address)" "[$SIGNER]" -r $WC_RPC)
  [[ ${predicted:l} == ${ACCOUNT:l} ]] || die "SIGNER predicts $predicted, not $ACCOUNT"
  if [[ $DRY_RUN == 1 ]]; then
    info "DRY RUN would POST $RELAYER_URL/approver {signer}"
  else
    relayer /approver "$(jq -nc --arg s $SIGNER '{signer: $s}')"
    [[ $RELAYER_STATUS == 200 ]] || die "/approver HTTP $RELAYER_STATUS: ${RELAYER_BODY[1,200]}"
    [[ $(print -r -- $RELAYER_BODY | jq -r '.account | ascii_downcase') == ${ACCOUNT:l} ]] || die "relayer deployed a different account: $RELAYER_BODY"
    tx=$(print -r -- $RELAYER_BODY | jq -r '.txHash // empty')
    [[ -n $tx ]] && record whitechain "deploy ApproverAccount (relayer)" $tx
    for i in {1..30}; do [[ $(cast code $ACCOUNT -r $WC_RPC) != 0x ]] && break; sleep 2; done
    [[ $(cast code $ACCOUNT -r $WC_RPC) != 0x ]] || die "still no code at $ACCOUNT"
  fi
  pass "deployed"
fi

# ---- 2: simulated KYC in the mirror

step 2 "WB Soul MIRROR: register and set IsVerified (simulated KYC, not WhiteBIT)"
sid=$(cast call $MIRROR "soulOf(address)(uint256)" $ACCOUNT -r $WC_RPC | first)
if [[ $sid == 0 ]]; then
  mirror_send "registerSoul (mirror, simulated)" "registerSoul(address)" $ACCOUNT
  sid=$(cast call $MIRROR "soulOf(address)(uint256)" $ACCOUNT -r $WC_RPC | first)
fi
if [[ $sid == 0 ]]; then
  [[ $DRY_RUN == 1 ]] && info "DRY RUN would setAttribute(<new soul>, IsVerified, 1)" || die "no soul after registerSoul"
else
  v=$(cast call $MIRROR "soulAttributeValue(uint256,address)(bytes20)" $sid $IS_VERIFIED -r $WC_RPC)
  [[ ${v:l} == $VERIFIED ]] || mirror_send "setAttribute IsVerified (mirror, simulated)" "setAttribute(uint256,address,bytes20)" $sid $IS_VERIFIED $VERIFIED
fi
pass "soul ${sid/#0/(new)} verified in the mirror (simulated)"

# ---- 3: APPROVER on ENS (Sepolia)

step 3 "grant APPROVER on $REGISTRY (Ethereum Sepolia)"
roles=$(cast call $REGISTRY "roles(uint256,address)(uint256)" 0 $ACCOUNT -r $SEPOLIA_RPC | first)
if has_bit $roles 64; then
  pass "already an approver on ENS"
else
  send sepolia "grantRootRoles APPROVER" $REGISTRY "grantRootRoles(uint256,address)" $ROLE_APPROVER $ACCOUNT
  pass "granted"
fi

# ---- 4: role synced to Whitechain

step 4 "sync the role to Whitechain through $RELAYER_URL/sync"
cached() { cast call $ROLE_CACHE "rolesOf(address,address)(uint256,uint64)" $REGISTRY $ACCOUNT -r $WC_RPC | head -1 | first }
if [[ $DRY_RUN == 1 ]]; then
  has_bit $(cached) 64 && pass "already cached on Whitechain" || info "DRY RUN would POST $RELAYER_URL/sync {registry, account} until in-sync/synced"
else
  ok=0
  for i in {1..40}; do
    relayer /sync "$(jq -nc --arg r $REGISTRY --arg a $ACCOUNT '{registry: $r, account: $a}')"
    [[ $RELAYER_STATUS == 200 ]] || die "/sync HTTP $RELAYER_STATUS: ${RELAYER_BODY[1,200]}"
    st=$(print -r -- $RELAYER_BODY | jq -r .status)
    tx=$(print -r -- $RELAYER_BODY | jq -r '.tx // empty')
    [[ -n $tx ]] && record whitechain "syncRoles (relayer)" $tx
    [[ $st == not-watched ]] && die "relayer does not watch $REGISTRY"
    if [[ $st == in-sync || $st == synced ]] && has_bit $(cached) 64; then ok=1; break; fi
    info "status $st (Whitechain lags Ethereum by about a minute), retrying in 15 s"
    sleep 15
  done
  (( ok )) || die "role not cached on Whitechain after 10 minutes"
  pass "APPROVER cached on Whitechain"
fi

# ---- 5: final check

step 5 "final check"
[[ $DRY_RUN == 1 ]] || {
  [[ $(cast code $ACCOUNT -r $WC_RPC) != 0x ]] || die "not deployed"
  has_bit $(cast call $REGISTRY "roles(uint256,address)(uint256)" 0 $ACCOUNT -r $SEPOLIA_RPC | first) 64 || die "no APPROVER on ENS"
  has_bit $(cached) 64 || die "no APPROVER in the Whitechain role cache"
}
pass "$([[ $DRY_RUN == 1 ]] && print 'final checks skipped' || print 'deployed, verified (simulated), APPROVER on ENS and on Whitechain')"

print_summary
[[ -n $RUN_JSON ]] && print -r -- "   recorded in ${RUN_JSON#$ROOT/}"
print; print -r -- "RESULT: PASS$([[ $DRY_RUN == 1 ]] && print ' (dry run: nothing was sent)')"
