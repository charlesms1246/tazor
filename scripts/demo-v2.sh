#!/usr/bin/env zsh
# Tazor v2 live demo: runs every PaymentModuleV2 / MandateModuleV2 / FinancingModule / EnsGate v2 feature
# end to end on Whitechain Sepolia (+ Ethereum Sepolia for the fallback). Stops at the first FAIL.
#
# Keys come only from the environment (never printed); the script sources $ENV_FILE (default
# tazor/.env.local) if present: PRIVATE_KEY (deployer/relayer/financier), PRIYA_KEY, CFO_KEY, MEERA_KEY.
# Overrides: DEPLOYER_KEY, WC_RPC, SEPOLIA_RPC, COMPANY_SALT, FINANCING_MODULE, ENSGATE_V2, PROVER_CMD,
# PRIYA_ACCOUNT, CFO_ACCOUNT, MEERA, BLUEJAY, EXIT_ACCOUNT.
# Every tx is recorded in $RUN_JSON (default scripts/demo-v2/last-run.json; not written in DRY_RUN) for
# scripts/verify-live.sh section 7.
# DRY_RUN=1 (anvil forks only): time is advanced with evm_increaseTime, the L1->L2 deposit is relayed by
# impersonating the gate alias, and the role sync is emulated with anvil_setStorageAt.
# Needs: cast, forge, jq, bc. Note: cast takes keys via --private-key, so they appear briefly in the local
# process list while each command runs.
set -u
setopt pipefail

ROOT=${0:A:h:h}
C=$ROOT/contracts
ENV_FILE=${ENV_FILE:-$ROOT/.env.local}
if [[ -f $ENV_FILE ]]; then set -a; source $ENV_FILE; set +a; fi
for bin in cast forge jq bc; do command -v $bin >/dev/null || { print -u2 "missing dependency: $bin"; exit 2; }; done

hexkey() { [[ -n ${1:-} ]] && print -r -- "0x${1#0x}" }
DEPLOYER_KEY=$(hexkey ${DEPLOYER_KEY:-${PRIVATE_KEY:-}})
PRIYA_KEY=$(hexkey ${PRIYA_KEY:-})
CFO_KEY=$(hexkey ${CFO_KEY:-})
MEERA_KEY=$(hexkey ${MEERA_KEY:-})
for k in DEPLOYER_KEY PRIYA_KEY CFO_KEY MEERA_KEY; do
  [[ -n ${(P)k} ]] || { print -u2 "$k is not set (env or $ENV_FILE)"; exit 2; }
done

DRY_RUN=${DRY_RUN:-0}
WC_RPC=${WC_RPC:-https://rpc.testnet.whitechain.io}
SEPOLIA_RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
WC_TX=https://explorer.testnet.whitechain.io/tx
L1_TX=https://sepolia.etherscan.io/tx
WC_JSON=$C/deployments/1874.json
L1_JSON=$C/deployments/11155111.json
jqa() { jq -r "$2 // empty" $1 }

PM=${PAYMENT_MODULE_V2:-$(jqa $WC_JSON .PaymentModuleV2)}
MM=${MANDATE_MODULE_V2:-$(jqa $WC_JSON .MandateModuleV2)}
FM=${FINANCING_MODULE:-$(jqa $WC_JSON .FinancingModule)}
RC=$(jqa $WC_JSON .RoleCache)
USDT=$(jqa $WC_JSON .USDT)
GATE2=${ENSGATE_V2:-$(jqa $L1_JSON .EnsGateV2)}
L1BLOCK=0x4200000000000000000000000000000000000015
ACME_REGISTRY=0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1
PRIYA=${PRIYA_ACCOUNT:-0x00aBed5bDddf794c415eE746d3E4De5332cC5450}
CFO=${CFO_ACCOUNT:-0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967}
MEERA=${MEERA:-0x03C291d446b870e0B8F128681937a9eCEDa97763}
BLUEJAY=${BLUEJAY:-0xc1dce946D192e344251972470237F1471C93876c}
EXIT_ACCOUNT=${EXIT_ACCOUNT:-0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6}
COMPANY_SALT=${COMPANY_SALT:-acme-p2}
PROVER_CMD=${PROVER_CMD:-bun packages/prover/scripts/sync-roles.ts}
ROLE_APPROVER=$(cast to-dec 0x10000000000000000)

DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
PRIYA_EOA=$(cast wallet address --private-key $PRIYA_KEY)
CFO_EOA=$(cast wallet address --private-key $CFO_KEY)
MEERA_EOA=$(cast wallet address --private-key $MEERA_KEY)

RUN_JSON=${RUN_JSON:-$ROOT/scripts/demo-v2/last-run.json}
[[ $DRY_RUN == 1 ]] && RUN_JSON=${RUN_JSON_DRY:-}
record_init() {
  [[ -n $RUN_JSON ]] || return 0
  jq -n --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg company "$1" --arg salt "$COMPANY_SALT" \
    '{startedAt: $started, company: $company, salt: $salt, txs: []}' > $RUN_JSON
}
record_tx() {   # <step> <label> <chain> <hash>
  [[ -n $RUN_JSON && -f $RUN_JSON ]] || return 0
  local tmp=$RUN_JSON.tmp
  jq --argjson step $1 --arg label "$2" --arg chain $3 --arg hash $4 \
    '.txs += [{step: $step, label: $label, chain: $chain, hash: $hash}]' $RUN_JSON > $tmp && mv $tmp $RUN_JSON
}

typeset -a SUMMARY
STEP=0
step() { STEP=$1; print; print -r -- "== STEP $1: $2" }
info() { print -r -- "   $*" }
pass() { print -r -- "STEP $STEP PASS  $*" }
die() { print -r -- "STEP $STEP FAIL  $*"; print_summary; exit 1 }
row() {
  SUMMARY+=("$STEP|$1|$2|${3:--}")
  local hash=${1##* } label=${1% *} chain=whitechain
  [[ $label == *"(Sepolia)"* ]] && chain=sepolia
  record_tx $STEP "$label" $chain $hash
}
print_summary() {
  print; print -r -- "== Summary"
  printf '%-5s | %-66s | %9s | %s\n' step "tx" gas latency
  for r in $SUMMARY; do
    local p=("${(@s:|:)r}")
    printf '%-5s | %-66s | %9s | %s\n' $p[1] $p[2] $p[3] $p[4]
  done
}
link() { [[ $DRY_RUN == 1 ]] && print -r -- "$1 (anvil)" || print -r -- "$2/$1" }

# ---- chain helpers

wc_now() { cast to-dec $(cast block latest --field timestamp -r $WC_RPC) }
l1_known() { cast call $L1BLOCK "number()(uint64)" -r $WC_RPC | awk '{print $1}' }
usdt_of() { cast call $USDT "balanceOf(address)(uint256)" $1 -r $WC_RPC | awk '{print $1}' }

# wait_until <unix ts>: until the latest Whitechain block is at or past ts
wait_until() {
  local target=$1 now
  while true; do
    now=$(wc_now)
    (( now >= target )) && return
    if [[ $DRY_RUN == 1 ]]; then
      cast rpc evm_increaseTime $((target - now)) -r $WC_RPC >/dev/null
      cast rpc evm_mine -r $WC_RPC >/dev/null
    else
      info "waiting $((target - now)) s (chain time)"
      sleep $(( target - now < 10 ? target - now : 10 ))
    fi
  done
}

LAST_TX="" LAST_GAS=""
# send <rpc> <key> <to> <sig> [args...]   -> sets LAST_TX / LAST_GAS, dies on failure
send() {
  local rpc=$1 key=$2 to=$3; shift 3
  local out
  out=$(cast send $to "$@" --private-key $key -r $rpc --json 2>&1) || die "tx failed: ${out[1,400]}"
  [[ $(print -r -- $out | jq -r .status) == 0x1 ]] || die "tx reverted: $(print -r -- $out | jq -r .transactionHash)"
  LAST_TX=$(print -r -- $out | jq -r .transactionHash)
  LAST_GAS=$(cast to-dec $(print -r -- $out | jq -r .gasUsed))
}
send_wc() { send $WC_RPC "$@" }

# expect_revert <ErrorSignature> <to> <sig> [args...]  (simulated from the deployer)
expect_revert() {
  local err=$1 to=$2; shift 2
  local out want got
  want=$(cast sig "$err")
  if out=$(cast call $to "$@" --from $DEPLOYER -r $WC_RPC 2>&1); then die "expected revert $err, call succeeded"; fi
  got=$(print -r -- $out | grep -oE 'data: "0x[0-9a-fA-F]+' | head -1 | sed 's/data: "//')
  [[ ${got[1,10]} == $want ]] || die "expected $err ($want), got: ${out[1,300]}"
  info "reverted as expected: $err  data=${got[1,74]}"
}

sign_raw() { cast wallet sign --no-hash $2 --private-key $1 }
# ApproverAccount approval: abi.encode(bytes[] [backup EOA], bytes[] [65-byte sig over the raw digest])
approval() { cast abi-encode "f(bytes[],bytes[])" "[$2]" "[$(sign_raw $1 $3)]" }
typed() { cast call $PM "typedDigest(bytes32)(bytes32)" $1 -r $WC_RPC }
th() { cast call $PM "$1()(bytes32)" -r $WC_RPC }

NONCE_BASE=$(( $(date +%s) * 1000 ))
NONCE_I=0
# sets NONCE (not usable in $(...): the counter must survive in this shell)
next_nonce() { NONCE_I=$((NONCE_I + 1)); NONCE=$((NONCE_BASE + NONCE_I)) }
# auth_tuple <account> <payee> <amount> <expiry> <nonce>
auth_tuple() { print -r -- "($(cast keccak "tazor demo v2 invoice $5"),$1,$2,$3,$4,$5)" }
AUTH_T="(bytes32,address,address,uint256,uint64,uint256)"
invoice_digest() { cast call $PM "invoiceDigest($AUTH_T)(bytes32)" "$1" -r $WC_RPC }
PAYONE="payOne(address,$AUTH_T,address[],bytes[])"

# ---- preflight

step 0 "preflight"
for v in PM MM FM RC USDT GATE2; do
  [[ -n ${(P)v} ]] || die "$v address missing (deployments json or env)"
  info "$v ${(P)v}"
done
expect_true() { [[ $(cast call "$@" -r $WC_RPC) == true ]] }
expect_true $PRIYA "isSigner(bytes)(bool)" $PRIYA_EOA || die "PRIYA_KEY is not a signer of $PRIYA"
expect_true $CFO "isSigner(bytes)(bool)" $CFO_EOA || die "CFO_KEY is not a signer of $CFO"
[[ ${(L)MEERA_EOA} == ${(L)MEERA} ]] || die "MEERA_KEY does not control $MEERA"
[[ $(cast code $MEERA -r $WC_RPC) == 0xef0100* ]] || die "$MEERA has no EIP-7702 delegation"
info "deployer/relayer/financier $DEPLOYER, Priya $PRIYA, CFO $CFO, Meera $MEERA"
info "deployer USDT $(usdt_of $DEPLOYER)"
pass "keys match the live entities"

# ---- 1. company

step 1 "create company \"$COMPANY_SALT\" (v2: payment, mandate, financing) and fund 12 USDT"
company_env=(
  VERSION=2 EXECUTORS=payment,mandate,financing FINANCING_MODULE=$FM ADMINS=$PRIYA,$CFO THRESHOLD=1
  REGISTRY=$ACME_REGISTRY TWO_APPROVER_THRESHOLD=5000000 PER_PAYMENT_LIMIT=8000000 MONTHLY_LIMIT=20000000
  PAYEE_DELAY=120 FRESH_THRESHOLD=3000000 MAX_CACHE_AGE=300 AGENT_MONTHLY_CAP=3000000
  EXIT_ACCOUNTS=$EXIT_ACCOUNT EXIT_DELAY=180 SALT=$COMPANY_SALT PRIVATE_KEY=$DEPLOYER_KEY
)
sim=$(cd $C && env $company_env forge script script/CreateCompany.s.sol --rpc-url $WC_RPC 2>&1) || die "simulation failed: ${sim[-400,-1]}"
ACCOUNT=$(print -r -- $sim | grep -oE 'TazorAccount \(v2\) 0x[0-9a-fA-F]{40}' | awk '{print $3}')
[[ -n $ACCOUNT ]] || die "could not read the company address"
[[ $(cast code $ACCOUNT -r $WC_RPC) == 0x ]] || die "$ACCOUNT already exists; rerun with COMPANY_SALT=<new name>"
record_init $ACCOUNT
out=$(cd $C && env $company_env forge script script/CreateCompany.s.sol --rpc-url $WC_RPC --broadcast 2>&1) || die "create failed: ${out[-400,-1]}"
run=$C/broadcast/CreateCompany.s.sol/$(cast chain-id -r $WC_RPC)/run-latest.json
LAST_TX=$(jq -r '.receipts[-1].transactionHash' $run); LAST_GAS=$(cast to-dec $(jq -r '.receipts[-1].gasUsed' $run))
[[ $(cast code $ACCOUNT -r $WC_RPC) != 0x ]] || die "no code at $ACCOUNT"
info "company $ACCOUNT  create tx $(link $LAST_TX $WC_TX)"
row "create $LAST_TX" $LAST_GAS
send_wc $DEPLOYER_KEY $USDT "transfer(address,uint256)" $ACCOUNT 12000000
row "fund $LAST_TX" $LAST_GAS
[[ $(usdt_of $ACCOUNT) == 12000000 ]] || die "funding failed"
pass "company $ACCOUNT holds 12 USDT  fund tx $(link $LAST_TX $WC_TX)"

# ---- 2. payee delay

step 2 "addPayee(bluejay) then the 120 s payee delay"
d=$(( $(wc_now) + 3600 ))
sig=$(approval $PRIYA_KEY $PRIYA_EOA $(typed $(cast keccak $(cast abi-encode "f(bytes32,address,address,uint256)" $(th ADD_PAYEE_TYPEHASH) $ACCOUNT $BLUEJAY $d))))
send_wc $DEPLOYER_KEY $PM "addPayee(address,address,address,uint256,bytes)" $ACCOUNT $BLUEJAY $PRIYA $d $sig
added_at=$(cast call $PM "payeeAddedAt(address,address)(uint64)" $ACCOUNT $BLUEJAY -r $WC_RPC | awk '{print $1}')
info "payee added at $added_at  tx $(link $LAST_TX $WC_TX)"; row "addPayee $LAST_TX" $LAST_GAS
next_nonce; n=$NONCE; a=$(auth_tuple $ACCOUNT $BLUEJAY 1000000 $(( $(wc_now) + 86400 )) $n)
s=$(approval $PRIYA_KEY $PRIYA_EOA $(invoice_digest $a))
expect_revert "PaymentPayeeNotAllowed(address)" $PM $PAYONE $ACCOUNT $a "[$PRIYA]" "[$s]"
wait_until $((added_at + 120))
send_wc $DEPLOYER_KEY $PM $PAYONE $ACCOUNT $a "[$PRIYA]" "[$s]"
row "payOne 1 USDT $LAST_TX" $LAST_GAS
pass "refused before the delay, paid 1 USDT after it  tx $(link $LAST_TX $WC_TX)"

# ---- 3. per-payment limit

step 3 "per-payment limit (9 USDT > 8)"
next_nonce; n=$NONCE; a=$(auth_tuple $ACCOUNT $BLUEJAY 9000000 $(( $(wc_now) + 86400 )) $n); dg=$(invoice_digest $a)
expect_revert "PaymentOverPerPaymentLimit(uint256,uint256)" $PM $PAYONE $ACCOUNT $a "[$PRIYA,$CFO]" \
  "[$(approval $PRIYA_KEY $PRIYA_EOA $dg),$(approval $CFO_KEY $CFO_EOA $dg)]"
pass "9 USDT refused with two approvers"

# ---- 4. fresh-proof rule

step 4 "fresh-proof rule (4 USDT > freshThreshold 3)"
cache=(${(f)"$(cast call $RC "rolesOf(address,address)(uint256,uint64)" $ACME_REGISTRY $PRIYA -r $WC_RPC)"})
cached_at=${cache[2]%% *}; known=$(l1_known); age=$((known - cached_at))
info "Priya cached at L1 block $cached_at, Whitechain knows $known: age $age blocks (max 300)"
next_nonce; n=$NONCE; a=$(auth_tuple $ACCOUNT $BLUEJAY 4000000 $(( $(wc_now) + 86400 )) $n)
s=$(approval $PRIYA_KEY $PRIYA_EOA $(invoice_digest $a))
if (( age > 300 )); then
  expect_revert "PaymentStaleRoles(address,uint64,uint64)" $PM $PAYONE $ACCOUNT $a "[$PRIYA]" "[$s]"
  if [[ $DRY_RUN == 1 ]]; then
    slot=$(cast keccak $(cast abi-encode "f(address,bytes32)" $PRIYA $(cast keccak $(cast abi-encode "f(address,uint256)" $ACME_REGISTRY 0))))
    next=0x$(print "obase=16; ibase=16; ${(U)slot#0x} + 1" | BC_LINE_LENGTH=0 bc)
    cast rpc anvil_setStorageAt $RC $(cast to-uint256 $next) $(cast to-uint256 $known) -r $WC_RPC >/dev/null
    info "DRY RUN: role sync emulated (cache l1Block := $known)"
  else
    info "syncing Priya's roles: $PROVER_CMD $ACME_REGISTRY $PRIYA"
    proof=$(cd $ROOT && ${=PROVER_CMD} $ACME_REGISTRY $PRIYA | tail -1) || die "prover failed"
    [[ $proof == 0x* ]] || die "prover printed no proof"
    send_wc $DEPLOYER_KEY $RC "syncRoles(address,address,bytes)" $ACME_REGISTRY $PRIYA $proof
    row "syncRoles $LAST_TX" $LAST_GAS
    info "synced  tx $(link $LAST_TX $WC_TX)"
  fi
  cache=(${(f)"$(cast call $RC "rolesOf(address,address)(uint256,uint64)" $ACME_REGISTRY $PRIYA -r $WC_RPC)"})
  info "cache now at L1 block ${cache[2]%% *}"
else
  info "cache is fresh; rule shown by config: $(cast call $PM "configV2Of(address)((address,uint96,uint96,uint96,uint32,uint96,uint32,uint96,address[],uint32))" $ACCOUNT -r $WC_RPC)"
fi
send_wc $DEPLOYER_KEY $PM $PAYONE $ACCOUNT $a "[$PRIYA]" "[$s]"
row "payOne 4 USDT $LAST_TX" $LAST_GAS
pass "4 USDT paid with a fresh role proof  tx $(link $LAST_TX $WC_TX)"

# ---- 5. provisional grant

step 5 "provisional grant: Meera (no ENS role) approves for 10 minutes"
valid_until=$(( $(wc_now) + 540 )); d=$(( $(wc_now) + 3600 ))
gsig=$(approval $PRIYA_KEY $PRIYA_EOA $(typed $(cast keccak $(cast abi-encode "f(bytes32,address,address,uint256,uint64,uint256)" \
  $(th PROVISIONAL_GRANT_TYPEHASH) $ACCOUNT $MEERA $ROLE_APPROVER $valid_until $d))))
send_wc $DEPLOYER_KEY $PM "provisionalGrant(address,address,uint256,uint64,address,uint256,bytes)" $ACCOUNT $MEERA $ROLE_APPROVER $valid_until $PRIYA $d $gsig
row "provisionalGrant $LAST_TX" $LAST_GAS
info "granted until $valid_until  tx $(link $LAST_TX $WC_TX)"
next_nonce; n=$NONCE; a=$(auth_tuple $ACCOUNT $BLUEJAY 500000 $(( $(wc_now) + 86400 )) $n)
msig=$(sign_raw $MEERA_KEY $(invoice_digest $a))   # Approver7702: plain 65-byte ECDSA
send_wc $DEPLOYER_KEY $PM $PAYONE $ACCOUNT $a "[$MEERA]" "[$msig]"
row "payOne 0.5 USDT (Meera) $LAST_TX" $LAST_GAS
pass "Meera paid 0.5 USDT under a provisional grant valid until $valid_until  tx $(link $LAST_TX $WC_TX)"

# ---- 6. agent cap

step 6 "agent: CFO payAsAgent within the 3 USDT cap"
AGENT="payAsAgent(address,$AUTH_T,address,bytes)"
next_nonce; n=$NONCE; a=$(auth_tuple $ACCOUNT $BLUEJAY 1000000 $(( $(wc_now) + 86400 )) $n)
send_wc $DEPLOYER_KEY $PM $AGENT $ACCOUNT $a $CFO $(approval $CFO_KEY $CFO_EOA $(invoice_digest $a))
row "payAsAgent 1 USDT $LAST_TX" $LAST_GAS
info "agent paid 1 USDT  tx $(link $LAST_TX $WC_TX)"
next_nonce; n=$NONCE; a=$(auth_tuple $ACCOUNT $BLUEJAY 2500000 $(( $(wc_now) + 86400 )) $n)
expect_revert "PaymentOverAgentCap(uint256,uint256)" $PM $AGENT $ACCOUNT $a $CFO $(approval $CFO_KEY $CFO_EOA $(invoice_digest $a))
pass "1 USDT paid, 2.5 USDT over the cap refused"

# ---- 7. contractor expiry

step 7 "contractor expiry: CFO invalid after 30 s"
until=$(( $(wc_now) + 30 )); d=$(( $(wc_now) + 3600 ))
esig=$(approval $PRIYA_KEY $PRIYA_EOA $(typed $(cast keccak $(cast abi-encode "f(bytes32,address,address,uint64,uint256)" \
  $(th APPROVER_EXPIRY_TYPEHASH) $ACCOUNT $CFO $until $d))))
send_wc $DEPLOYER_KEY $PM "setApproverExpiry(address,address,uint64,address,uint256,bytes)" $ACCOUNT $CFO $until $PRIYA $d $esig
row "setApproverExpiry $LAST_TX" $LAST_GAS
info "CFO expires at $until  tx $(link $LAST_TX $WC_TX)"
wait_until $((until + 5))
next_nonce; n=$NONCE; a=$(auth_tuple $ACCOUNT $BLUEJAY 200000 $(( $(wc_now) + 86400 )) $n)
expect_revert "PaymentNotVerified(address)" $PM $PAYONE $ACCOUNT $a "[$CFO]" "[$(approval $CFO_KEY $CFO_EOA $(invoice_digest $a))]"
pass "CFO refused after expiry (ENS role unchanged)"

# ---- 8. mandate

step 8 "mandate v2: 1 USDT per 30 days to bluejay"
MT="(address,address,uint256,uint64,uint64,uint256)"
next_nonce
m="($ACCOUNT,$BLUEJAY,1000000,2592000,$(( $(wc_now) + 2592000 )),$NONCE)"
mid=$(cast call $MM "mandateDigest($MT)(bytes32)" "$m" -r $WC_RPC)
send_wc $DEPLOYER_KEY $MM "createMandate($MT,address[],bytes[])" "$m" "[$PRIYA]" "[$(approval $PRIYA_KEY $PRIYA_EOA $mid)]"
row "createMandate $LAST_TX" $LAST_GAS
info "mandate $mid  tx $(link $LAST_TX $WC_TX)"
send_wc $DEPLOYER_KEY $MM "pull(bytes32,uint256)" $mid 600000
row "pull 0.6 USDT $LAST_TX" $LAST_GAS
info "pulled 0.6 USDT  tx $(link $LAST_TX $WC_TX)"
expect_revert "MandateOverCap(uint256,uint256)" $MM "pull(bytes32,uint256)" $mid 600000
pass "0.6 pulled, second 0.6 over the cap refused"

# ---- 9. financing

step 9 "financing: commit -> list -> buy -> settle"
FT="(bytes32,address,address,uint256,uint64,uint256)"
due=$(( $(wc_now) + 90 ))
next_nonce
f="($(cast keccak "tazor demo v2 financed $NONCE_BASE"),$ACCOUNT,$MEERA,2000000,$due,$NONCE)"
fd=$(cast call $FM "financedDigest($FT)(bytes32)" "$f" -r $WC_RPC)
send_wc $DEPLOYER_KEY $FM "commit($FT,address[],bytes[])" "$f" "[$PRIYA]" "[$(approval $PRIYA_KEY $PRIYA_EOA $fd)]"
row "commit $LAST_TX" $LAST_GAS
token=$(cast to-dec $fd)
info "claim $token held by Meera  tx $(link $LAST_TX $WC_TX)"
if (( $(cast to-dec $(cast balance $MEERA -r $WC_RPC)) < 5000000000000000 )); then
  send_wc $DEPLOYER_KEY $MEERA --value 0.01ether
  row "sponsor Meera 0.01 WBT $LAST_TX" $LAST_GAS
  info "SPONSORED: deployer sent Meera 0.01 WBT for gas  tx $(link $LAST_TX $WC_TX)"
fi
send_wc $MEERA_KEY $FM "list(uint256,uint256)" $token 1900000
row "list (Meera) $LAST_TX" $LAST_GAS
send_wc $DEPLOYER_KEY $USDT "approve(address,uint256)" $FM 1900000
row "approve $LAST_TX" $LAST_GAS
send_wc $DEPLOYER_KEY $FM "buy(uint256)" $token
row "buy $LAST_TX" $LAST_GAS
[[ ${(L)$(cast call $FM "ownerOf(uint256)(address)" $token -r $WC_RPC)} == ${(L)DEPLOYER} ]] || die "financier does not hold the claim"
info "financier bought the claim for 1.9 USDT  tx $(link $LAST_TX $WC_TX)"
wait_until $due
before=$(usdt_of $DEPLOYER)
send_wc $DEPLOYER_KEY $FM "settle(uint256)" $token
row "settle $LAST_TX" $LAST_GAS
(( $(usdt_of $DEPLOYER) - before == 2000000 )) || die "financier did not receive 2 USDT"
pass "settled: financier received 2 USDT from the company  tx $(link $LAST_TX $WC_TX)"

# ---- 10. fallback through Ethereum

step 10 "fallback v2: EnsGate v2 on Sepolia -> payFromL1 on Whitechain (0.3 USDT)"
next_nonce; n=$NONCE; a=$(auth_tuple $ACCOUNT $BLUEJAY 300000 $(( $(wc_now) + 86400 )) $n)
s=$(approval $PRIYA_KEY $PRIYA_EOA $(invoice_digest $a))
FWD="forward(string,address,$AUTH_T,address[],bytes[])"
start_block=$(cast block-number -r $WC_RPC)
gas=$(cast estimate $GATE2 $FWD acme $ACCOUNT $a "[$PRIYA]" "[$s]" --from $DEPLOYER -r $SEPOLIA_RPC) || die "forward estimate failed"
gas=$(( gas * 13 / 10 ))
send $SEPOLIA_RPC $DEPLOYER_KEY $GATE2 $FWD acme $ACCOUNT $a "[$PRIYA]" "[$s]" --gas-limit $gas
L1_HASH=$LAST_TX
row "forward (Sepolia) $L1_HASH" $LAST_GAS
t1=$(cast to-dec $(cast block $(cast receipt $L1_HASH blockNumber -r $SEPOLIA_RPC) --field timestamp -r $SEPOLIA_RPC))
info "forwarded on Sepolia  tx $(link $L1_HASH $L1_TX)  (gas limit $gas)"
if [[ $DRY_RUN == 1 ]]; then
  alias_addr=$(cast call $PM "ensGateAlias()(address)" -r $WC_RPC)
  cast rpc anvil_impersonateAccount $alias_addr -r $WC_RPC >/dev/null
  cast rpc anvil_setBalance $alias_addr 0x8AC7230489E80000 -r $WC_RPC >/dev/null
  out=$(cast send $PM "payFromL1(address,address,$AUTH_T,address[],bytes[])" $ACME_REGISTRY $ACCOUNT $a "[$PRIYA]" "[$s]" \
    --from $alias_addr --unlocked -r $WC_RPC --json 2>&1) || die "emulated deposit failed: ${out[1,300]}"
  info "DRY RUN: deposit relayed by impersonating $alias_addr"
fi
l2=""
for i in {1..90}; do
  l2=$(cast logs --from-block $start_block --address $PM "InvoicePaid(address indexed,uint256 indexed,address,uint256,bool)" \
    $ACCOUNT $n -r $WC_RPC --json 2>/dev/null | jq -c '.[0] // empty')
  [[ -n $l2 ]] && break
  info "waiting for the deposit on Whitechain ($((i * 10)) s)"; sleep 10
done
[[ -n $l2 ]] || die "no InvoicePaid on PaymentModuleV2 within 15 min"
L2_HASH=$(print -r -- $l2 | jq -r .transactionHash)
l2data=$(print -r -- $l2 | jq -r .data)
via=$(cast to-dec 0x${l2data[-64,-1]})
(( via == 1 )) || die "InvoicePaid.viaL1 is not true"
t2=$(cast to-dec $(cast block $(print -r -- $l2 | jq -r .blockNumber) --field timestamp -r $WC_RPC))
L2_GAS=$(cast to-dec $(cast receipt $L2_HASH gasUsed -r $WC_RPC))
row "payFromL1 (deposit) $L2_HASH" $L2_GAS "$((t2 - t1)) s"
pass "InvoicePaid viaL1 on Whitechain  tx $(link $L2_HASH $WC_TX)  latency $((t2 - t1)) s"

# ---- 11. time-locked exit (last: empties the account)

step 11 "time-locked exit to the acme v1 account (180 s)"
d=$(( $(wc_now) + 3600 ))
rsig=$(approval $PRIYA_KEY $PRIYA_EOA $(typed $(cast keccak $(cast abi-encode "f(bytes32,address,uint256,uint256)" $(th REQUEST_EXIT_TYPEHASH) $ACCOUNT 0 $d))))
send_wc $DEPLOYER_KEY $PM "requestExit(address,uint256,address,uint256,bytes)" $ACCOUNT 0 $PRIYA $d $rsig
row "requestExit $LAST_TX" $LAST_GAS
exit_info=(${(f)"$(cast call $PM "pendingExit(address)(address,uint64)" $ACCOUNT -r $WC_RPC)"})
execute_after=${exit_info[2]%% *}
info "exit to ${exit_info[1]} after $execute_after  tx $(link $LAST_TX $WC_TX)"
wait_until $execute_after
bal=$(usdt_of $ACCOUNT); before=$(usdt_of $EXIT_ACCOUNT)
send_wc $DEPLOYER_KEY $PM "executeExit(address)" $ACCOUNT
row "executeExit $LAST_TX" $LAST_GAS
(( $(usdt_of $ACCOUNT) == 0 && $(usdt_of $EXIT_ACCOUNT) - before == bal )) || die "exit did not move the balance"
pass "moved $bal USDT base units to $EXIT_ACCOUNT  tx $(link $LAST_TX $WC_TX)"

print_summary
print; print -r -- "ALL STEPS PASS"
