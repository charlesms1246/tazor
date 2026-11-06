#!/usr/bin/env zsh
# One-time setup of the public SANDBOX company for /autopilot, TESTNET ONLY (Whitechain Sepolia + Ethereum Sepolia).
#   1. demo keys: sandbox admin, "Ravi" (an approver to revoke), the supplier signer, a financier and the sandbox operator.
#      New keys are APPENDED to $ENV_FILE as SANDBOX_*_KEY and never printed; existing ones are reused.
#   2. ApproverAccounts (only signer = the key's 20-byte EOA) for the admin, Ravi, the supplier signer and the financier
#      (relayer POST /approver, else the factory directly).
#   3. sandbox.taz0r.eth through CompanyCreator: ENS name + registry, admin = the deployer, approvers = admin, Ravi and
#      the supplier signer (Sandbox Supplier's account uses this registry too);
#      then the OPERATOR key gets APPROVER-admin (1<<192) on the SANDBOX registry only (so the relayer can admit guests).
#   4. WB Soul MIRROR (simulated KYC): souls for the four ApproverAccounts, then MirrorOperator is deployed and becomes
#      the mirror's owner with the OPERATOR key whitelisted. THIS IS THE ONE TRUST CHANGE (printed below).
#   5. Two TazorAccounts v2: the sandbox buyer (per payment 1 USDT, monthly 10, agent 1, two approvers above 0.5 USDT,
#      payee delay 60 s, exit to the deployer after 120 s) and "Sandbox Supplier".
#   6. Funding (top-ups only): sandbox 15 USDT; operator 0.3 WBT + 0.05 Sepolia ETH; each demo EOA (admin, Ravi,
#      supplier signer, financier) 0.1 WBT, since the relayer sends their counterparty txs from them; financier 2 USDT.
#   7. ENS records for sandbox.taz0r.eth (name, tazor.role buyer, ENSIP-11 Whitechain address, coin type 0x80000752).
#   8. Role sync to Whitechain via the relayer's POST /sync; if the relayer doesn't watch the sandbox registry yet,
#      it proves locally (bun packages/prover/scripts/sync-roles.ts) and sends RoleCache.syncRoles itself.
#   9. Sandbox Supplier added as a payee of the sandbox (approved by the sandbox admin).
#  10. One mandate (sandbox → Sandbox Supplier, 0.5 USDT per 30 days) and one financing claim (0.4 USDT, holder = the
#      supplier signer EOA) listed at 0.38 USDT; their ids go to setup.json (reused on re-runs).
# Everything is idempotent: each step reads the chain first and only sends what is missing, so a re-run resumes.
#
# Usage:   zsh scripts/setup-sandbox.sh
#          DRY_RUN=1 zsh scripts/setup-sandbox.sh     # reads only; prints the plan and every tx it would send
# Keys come only from the environment (never printed); sources $ENV_FILE (default tazor/.env.local):
#   PRIVATE_KEY (or DEPLOYER_KEY): deployer = CompanyCreator operator, WB Soul mirror owner, USDT/WBT/ETH funder.
# Overrides: WC_RPC, SEPOLIA_RPC (default tenderly), RELAYER_URL, SANDBOX_LABEL (sandbox), SANDBOX_SALT, SUPPLIER_SALT,
#   DAILY_CAP (mirror operator, 40), PROVER_CMD. Records to scripts/sandbox/setup.json (DRY_RUN: setup.dry-run.json).
# Needs: cast, forge, jq, curl, python3, bc, node (+ bun for the local prover fallback).
# cast/forge take the deployer key via --private-key/env, so it appears briefly in the local process list.
set -u
setopt pipefail

ROOT=${0:A:h:h}
C=$ROOT/contracts
ENV_FILE=${ENV_FILE:-$ROOT/.env.local}
if [[ -f $ENV_FILE ]]; then set -a; source $ENV_FILE; set +a; fi
for bin in cast forge jq curl python3 bc node; do command -v $bin >/dev/null || { print -u2 "missing dependency: $bin"; exit 2; }; done

DRY_RUN=${DRY_RUN:-0}
WC_RPC=${WC_RPC:-https://rpc.testnet.whitechain.io}
SEPOLIA_RPC=${SEPOLIA_RPC:-https://sepolia.gateway.tenderly.co}
RELAYER_URL=${RELAYER_URL:-https://tazor-relayer.vercel.app}
RELAYER_URL=${RELAYER_URL%/}
LABEL=${SANDBOX_LABEL:-sandbox}
SANDBOX_SALT=${SANDBOX_SALT:-tazor-sandbox}
SUPPLIER_SALT=${SUPPLIER_SALT:-tazor-sandbox-supplier}
DAILY_CAP=${DAILY_CAP:-40}
PROVER_CMD=${PROVER_CMD:-bun packages/prover/scripts/sync-roles.ts}
WC_TX=https://explorer.testnet.whitechain.io/tx
SEP_TX=https://sepolia.etherscan.io/tx
WC_JSON=$C/deployments/1874.json
L1_JSON=$C/deployments/11155111.json
jqa() { jq -r "$2 // empty" $1 }

AA_FACTORY=$(jqa $WC_JSON .ApproverAccountFactory)
MIRROR=$(jqa $WC_JSON .WBSoulMirror)
ROLE_CACHE=$(jqa $WC_JSON .RoleCache)
PM2=$(jqa $WC_JSON .PaymentModuleV2)
FM=$(jqa $WC_JSON .FinancingModule)
USDT=$(jqa $WC_JSON .USDT)
CREATOR=$(jqa $L1_JSON .CompanyCreator)
PARENT=$(jqa $L1_JSON .ENS.taz0rSubregistry)
L1BLOCK=0x4200000000000000000000000000000000000015
IS_VERIFIED=0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41
VERIFIED=0x0000000000000000000000000000000000000001
ROLE_APPROVER=$(cast to-dec 0x10000000000000000)                                   # 1 << 64
ROLE_APPROVER_ADMIN=$(cast to-dec 0x1000000000000000000000000000000000000000000000000)   # 1 << 192
# what each sandbox ApproverAccount must hold on the sandbox registry (PaymentModuleV2: addPayee / provisionalGrant /
# setApproverExpiry need a cached TAZOR_ADMIN (1<<68); payments, exits, mandates and financing need APPROVER (1<<64))
typeset -A NEED_BITS

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

OUT=$ROOT/scripts/sandbox/setup.json
[[ $DRY_RUN == 1 ]] && OUT=$ROOT/scripts/sandbox/setup.dry-run.json
mkdir -p ${OUT:h}
typeset -a SUMMARY TXS
STEP=0
step() { STEP=$1; print; print -r -- "== STEP $1: $2" }
info() { print -r -- "   $*" }
pass() { print -r -- "STEP $STEP PASS  $([[ $DRY_RUN == 1 ]] && print '[dry run] ')$*" }
print_summary() {
  print; print -r -- "== Transactions"
  (( ${#SUMMARY} )) || { print -r -- "   none sent"; return }
  for r in $SUMMARY; do print -r -- "   $r"; done
}
die() { print -r -- "STEP $STEP FAIL  $*"; print_summary; print; print -r -- "RESULT: FAIL (re-run to resume; finished steps are skipped)"; exit 1 }
record() {   # <chain> <label> <hash>
  local url=$([[ $1 == sepolia ]] && print $SEP_TX || print $WC_TX)/$3
  SUMMARY+=("step $STEP  $2  $url")
  TXS+=("$(jq -nc --argjson step $STEP --arg chain $1 --arg label "$2" --arg hash $3 '{step: $step, chain: $chain, label: $label, hash: $hash}')")
}

# ---- chain helpers (explicit sequential nonces per chain, like admit-approver.sh)

has_bit() { python3 -c "import sys; sys.exit(0 if (int('$1', 0) >> $2) & 1 else 1)" }   # <uint> <bit>
first() { awk '{print $1}' }
ge() { [[ $(print "$1 >= $2" | bc) == 1 ]] }   # big-number compare
typeset -A NONCE
next_nonce() {   # <chain> <rpc> -> NONCE_OUT
  if [[ -z ${NONCE[$1]:-} ]]; then NONCE[$1]=$(cast nonce $DEPLOYER --block pending -r $2); else NONCE[$1]=$(( NONCE[$1] + 1 )); fi
  NONCE_OUT=${NONCE[$1]}
}
LAST_TX="" LAST_BLOCK=0
send() {   # <chain> <label> <to> <sig> [args...] [--value <wei>] -> LAST_TX, LAST_BLOCK
  local chain=$1 label=$2 to=$3; shift 3
  local rpc=$([[ $chain == sepolia ]] && print $SEPOLIA_RPC || print $WC_RPC)
  if [[ $DRY_RUN == 1 ]]; then
    info "DRY RUN would send on $chain: $label → $to $1"
    LAST_TX=; LAST_BLOCK=0; return 0
  fi
  next_nonce $chain $rpc
  local out attempt
  for attempt in 1 2 3; do
    out=$(cast send $to "$@" --nonce $NONCE_OUT --private-key $DEPLOYER_KEY -r $rpc --json 2>&1) && break
    [[ $attempt != 3 && $out =~ '(timeout|rate limit|429|503|nonce too low|replacement)' ]] || die "$label failed: ${out[1,300]}"
    info "retry $attempt: ${out[1,120]}"; sleep $((5 * attempt))
    NONCE[$chain]=; next_nonce $chain $rpc
  done
  LAST_TX=$(print -r -- $out | jq -r .transactionHash)
  [[ $(print -r -- $out | jq -r .status) == 0x1 ]] || die "$label reverted: $LAST_TX"
  LAST_BLOCK=$(cast to-dec $(print -r -- $out | jq -r .blockNumber))
  record $chain "$label" $LAST_TX
  info "$label  $([[ $chain == sepolia ]] && print $SEP_TX || print $WC_TX)/$LAST_TX"
}
send_value() {   # <chain> <label> <to> <wei>: a plain transfer
  local chain=$1 label=$2 to=$3 wei=$4
  local rpc=$([[ $chain == sepolia ]] && print $SEPOLIA_RPC || print $WC_RPC)
  if [[ $DRY_RUN == 1 ]]; then info "DRY RUN would send $(cast from-wei $wei) native on $chain to $to"; return 0; fi
  next_nonce $chain $rpc
  local out
  out=$(cast send $to --value $wei --nonce $NONCE_OUT --private-key $DEPLOYER_KEY -r $rpc --json 2>&1) || die "$label failed: ${out[1,300]}"
  LAST_TX=$(print -r -- $out | jq -r .transactionHash)
  [[ $(print -r -- $out | jq -r .status) == 0x1 ]] || die "$label reverted: $LAST_TX"
  record $chain "$label" $LAST_TX
  info "$label  $([[ $chain == sepolia ]] && print $SEP_TX || print $WC_TX)/$LAST_TX"
}
MIRROR_VIA=""
mirror_send() {   # <label> <sig> [args...]: a mirror write, direct or through MirrorOperator.execute
  local label=$1 sig=$2; shift 2
  if [[ -n $MIRROR_VIA ]]; then send whitechain "$label via MirrorOperator" $MIRROR_VIA "execute(bytes)" $(cast calldata "$sig" "$@")
  else send whitechain "$label" $MIRROR "$sig" "$@"; fi
}
relayer() {   # <method> <path> [json] -> RELAYER_BODY, RELAYER_STATUS (never dies: the caller decides)
  local out
  if [[ $1 == GET ]]; then out=$(curl -sS -m 60 "$RELAYER_URL$2" -w '\n%{http_code}' 2>&1)
  else out=$(curl -sS -m 120 -X POST "$RELAYER_URL$2" -H 'content-type: application/json' -d "$3" -w '\n%{http_code}' 2>&1); fi
  RELAYER_STATUS=${out##*$'\n'}
  RELAYER_BODY=${out%$'\n'*}
}
sign_raw() { cast wallet sign --no-hash $2 --private-key $1 }
# ApproverAccount approval: abi.encode(bytes[] [signer EOA], bytes[] [65-byte sig over the raw digest])
approval() { cast abi-encode "f(bytes[],bytes[])" "[$2]" "[$(sign_raw $1 $3)]" }
usdt_of() { cast call $USDT "balanceOf(address)(uint256)" $1 -r $WC_RPC | first }

print -r -- "Tazor: set up the public sandbox company $LABEL.taz0r.eth$([[ $DRY_RUN == 1 ]] && print '  DRY RUN (nothing is sent, no keys are written)')"

# ---- 0: preflight

step 0 "preflight (testnet only)"
[[ $(cast chain-id -r $WC_RPC) == 1874 ]] || die "WC_RPC is not Whitechain Sepolia (1874)"
[[ $(cast chain-id -r $SEPOLIA_RPC) == 11155111 ]] || die "SEPOLIA_RPC is not Ethereum Sepolia (11155111)"
for v in AA_FACTORY MIRROR ROLE_CACHE PM2 FM USDT CREATOR PARENT; do [[ -n ${(P)v} ]] || die "$v missing from deployments"; info "$v ${(P)v}"; done
[[ ${(L)$(cast call $CREATOR "operator()(address)" -r $SEPOLIA_RPC)} == ${(L)DEPLOYER} ]] || die "deployer $DEPLOYER is not the CompanyCreator operator"
mirror_owner=$(cast call $MIRROR "owner()(address)" -r $WC_RPC)
MIRROR_OPERATOR=""
if [[ ${(L)mirror_owner} != ${(L)DEPLOYER} ]]; then
  [[ ${(L)$(cast call $mirror_owner "owner()(address)" -r $WC_RPC 2>/dev/null)} == ${(L)DEPLOYER} ]] || die "the mirror is owned by $mirror_owner, which the deployer does not control"
  MIRROR_OPERATOR=$mirror_owner MIRROR_VIA=$mirror_owner
  info "mirror already owned by MirrorOperator $MIRROR_OPERATOR (owned by the deployer)"
fi
dep_usdt=$(usdt_of $DEPLOYER)
info "deployer $DEPLOYER: $(cast balance $DEPLOYER --ether -r $WC_RPC) WBT, $(cast balance $DEPLOYER --ether -r $SEPOLIA_RPC) Sepolia ETH, $(cast from-wei $dep_usdt mwei) USDT"
relayer GET /health
[[ $RELAYER_STATUS == 200 ]] && info "relayer $RELAYER_URL: sender $(print -r -- $RELAYER_BODY | jq -r .relayer), roleSync $(print -r -- $RELAYER_BODY | jq -r '.roleSync // false')" \
  || info "relayer $RELAYER_URL unreachable (HTTP $RELAYER_STATUS): approver deploys and syncs will use the local fallbacks"
pass "testnets, CompanyCreator operator and mirror owner ok"

# ---- 1: keys

step 1 "demo keys (testnet only; appended to ${ENV_FILE#$ROOT/} without printing)"
typeset -a NEW_KEYS
ensure_key() {   # <VAR>: reuse from the environment, else generate (and append unless DRY_RUN)
  local var=$1
  [[ -n ${(P)var:-} ]] && { info "$var: reusing"; return 0; }
  local k=$(cast wallet new --json | jq -r '.[0].private_key')
  typeset -g "$var=$k"
  if [[ $DRY_RUN == 1 ]]; then info "$var: generated in memory for the dry run (not written)"; return 0; fi
  if (( ${#NEW_KEYS} == 0 )); then
    [[ -s $ENV_FILE && -n $(tail -c1 $ENV_FILE) ]] && print >> $ENV_FILE
    print -r -- "# sandbox demo keys (testnet only), added by scripts/setup-sandbox.sh on $(date -u +%Y-%m-%d)" >> $ENV_FILE
  fi
  print -r -- "$var=$k" >> $ENV_FILE
  NEW_KEYS+=($var)
  info "$var: generated and appended"
}
for v in SANDBOX_ADMIN_KEY SANDBOX_RAVI_KEY SANDBOX_SUPPLIER_KEY SANDBOX_FINANCIER_KEY SANDBOX_OPERATOR_KEY; do ensure_key $v; done
ADMIN_EOA=$(cast wallet address --private-key $(hexkey $SANDBOX_ADMIN_KEY))
RAVI_EOA=$(cast wallet address --private-key $(hexkey $SANDBOX_RAVI_KEY))
SUPPLIER_EOA=$(cast wallet address --private-key $(hexkey $SANDBOX_SUPPLIER_KEY))
FINANCIER=$(cast wallet address --private-key $(hexkey $SANDBOX_FINANCIER_KEY))
OPERATOR=$(cast wallet address --private-key $(hexkey $SANDBOX_OPERATOR_KEY))
info "admin EOA $ADMIN_EOA · Ravi EOA $RAVI_EOA · supplier signer EOA $SUPPLIER_EOA · financier $FINANCIER · operator $OPERATOR"
pass "${#NEW_KEYS} new key(s)$([[ ${#NEW_KEYS} -gt 0 ]] && print ": ${(j:, :)NEW_KEYS}")"

# ---- 2: approver accounts (Whitechain)

step 2 "ApproverAccounts for the admin, Ravi, the supplier signer and the financier"
predict() { cast call $AA_FACTORY "predictAddress(bytes[])(address)" "[$1]" -r $WC_RPC }
ensure_approver() {   # <name> <eoa> -> AA_OUT
  local name=$1 eoa=$2 aa
  aa=$(predict $eoa)
  AA_OUT=$aa
  [[ $(cast code $aa -r $WC_RPC) != 0x ]] && { info "$name ApproverAccount $aa: deployed"; return 0; }
  if [[ $DRY_RUN == 1 ]]; then info "DRY RUN would deploy $name ApproverAccount $aa (relayer POST /approver, else factory.createAccount)"; return 0; fi
  relayer POST /approver "$(jq -nc --arg s $eoa '{signer: $s}')"
  if [[ $RELAYER_STATUS == 200 && $(print -r -- $RELAYER_BODY | jq -r '.account | ascii_downcase') == ${(L)aa} ]]; then
    local tx=$(print -r -- $RELAYER_BODY | jq -r '.txHash // empty')
    [[ -n $tx ]] && { cast receipt $tx -r $WC_RPC >/dev/null 2>&1; record whitechain "$name ApproverAccount (relayer)" $tx; }
  else
    info "relayer /approver HTTP $RELAYER_STATUS; deploying through the factory"
    send whitechain "$name ApproverAccount" $AA_FACTORY "createAccount(bytes[])" "[$eoa]"
  fi
  [[ $(cast code $aa -r $WC_RPC) != 0x ]] || die "no code at $aa after deploy"
  info "$name ApproverAccount $aa"
}
ensure_approver admin $ADMIN_EOA; ADMIN_AA=$AA_OUT
ensure_approver Ravi $RAVI_EOA; RAVI_AA=$AA_OUT
ensure_approver "supplier signer" $SUPPLIER_EOA; SUPPLIER_AA=$AA_OUT
ensure_approver financier $FINANCIER; FINANCIER_AA=$AA_OUT
NEED_BITS[$ADMIN_AA]="64 68"; NEED_BITS[$RAVI_AA]="64"; NEED_BITS[$SUPPLIER_AA]="64 68"
pass "admin $ADMIN_AA · Ravi $RAVI_AA · supplier signer $SUPPLIER_AA · financier $FINANCIER_AA"

# ---- 3: ENS company (Ethereum Sepolia)

step 3 "$LABEL.taz0r.eth: ENS name + registry (CompanyCreator); admin + supplier signer APPROVER+TAZOR_ADMIN, Ravi APPROVER; operator APPROVER-admin"
REGISTRY=$(cast call $PARENT "getSubregistry(string)(address)" $LABEL -r $SEPOLIA_RPC)
ENS_BLOCK=0
if [[ $REGISTRY == 0x0000000000000000000000000000000000000000 ]]; then
  expiry=$(( $(date +%s) + 365 * 86400 ))
  send sepolia "createCompany $LABEL" $CREATOR "createCompany(string,address,address[],uint64)" $LABEL $DEPLOYER "[$ADMIN_AA,$RAVI_AA,$SUPPLIER_AA]" $expiry
  ENS_BLOCK=$LAST_BLOCK
  if [[ $DRY_RUN == 1 ]]; then
    REGISTRY=""
    info "DRY RUN: the registry address is known after createCompany; later steps show what they would do"
  else
    REGISTRY=$(cast call $PARENT "getSubregistry(string)(address)" $LABEL -r $SEPOLIA_RPC)
    [[ $REGISTRY != 0x0000000000000000000000000000000000000000 ]] || die "no registry for $LABEL after createCompany"
  fi
else
  info "$LABEL.taz0r.eth exists: registry $REGISTRY"
  has_bit $(cast call $REGISTRY "roles(uint256,address)(uint256)" 0 $DEPLOYER -r $SEPOLIA_RPC | first) 192 \
    || die "$LABEL.taz0r.eth exists but the deployer is not its APPROVER-admin (choose another SANDBOX_LABEL)"
fi
if [[ -n $REGISTRY ]]; then
  for pair in "admin $ADMIN_AA" "Ravi $RAVI_AA" "supplier-signer $SUPPLIER_AA"; do
    who=${pair%% *} a=${pair#* }
    roles=$(cast call $REGISTRY "roles(uint256,address)(uint256)" 0 $a -r $SEPOLIA_RPC | first)
    missing=$(python3 -c "need=sum(1 << int(b) for b in '${NEED_BITS[$a]}'.split()); print(need & ~int('$roles', 0))")
    if [[ $missing == 0 ]]; then info "$who holds bits ${NEED_BITS[$a]}"; continue; fi
    send sepolia "grant $who roles (bits ${NEED_BITS[$a]}; missing mask $(python3 -c "print(hex($missing))"))" $REGISTRY "grantRootRoles(uint256,address)" $missing $a
    ENS_BLOCK=$LAST_BLOCK
  done
  if has_bit $(cast call $REGISTRY "roles(uint256,address)(uint256)" 0 $OPERATOR -r $SEPOLIA_RPC | first) 192; then
    info "operator $OPERATOR already APPROVER-admin on $REGISTRY"
  else
    send sepolia "grant APPROVER-admin (1<<192) to the operator, sandbox registry only" $REGISTRY "grantRootRoles(uint256,address)" $ROLE_APPROVER_ADMIN $OPERATOR
  fi
else
  info "DRY RUN would grant APPROVER-admin (1<<192) on the new registry to operator $OPERATOR"
fi
pass "registry ${REGISTRY:-<created on send>}"

# ---- 4: WB Soul mirror (simulated) and the MirrorOperator trust change

step 4 "WB Soul MIRROR: verified souls (simulated KYC), then MirrorOperator becomes the mirror owner"
# the EOAs too: FinancingModule only lets a claim be held by a Tazor account or a verified soul (supplier signer = holder,
# financier = buyer)
for pair in "admin $ADMIN_AA" "Ravi $RAVI_AA" "supplier-signer $SUPPLIER_AA" "financier $FINANCIER_AA" "supplier-signer-EOA $SUPPLIER_EOA" "financier-EOA $FINANCIER"; do
  who=${pair%% *} a=${pair#* }
  sid=$(cast call $MIRROR "soulOf(address)(uint256)" $a -r $WC_RPC | first)
  if [[ $sid == 0 ]]; then
    mirror_send "registerSoul $who (mirror, simulated)" "registerSoul(address)" $a
    sid=$(cast call $MIRROR "soulOf(address)(uint256)" $a -r $WC_RPC | first)
  fi
  if [[ $sid == 0 ]]; then info "DRY RUN would setAttribute(<new soul of $who>, IsVerified, 1)"; continue; fi
  v=$(cast call $MIRROR "soulAttributeValue(uint256,address)(bytes20)" $sid $IS_VERIFIED -r $WC_RPC)
  [[ ${v:l} == $VERIFIED ]] && info "$who soul $sid verified" \
    || mirror_send "setAttribute IsVerified $who (mirror, simulated)" "setAttribute(uint256,address,bytes20)" $sid $IS_VERIFIED $VERIFIED
done
print
print -r -- "   ************************************************************************************************"
print -r -- "   TRUST CHANGE: the WB Soul MIRROR (simulated KYC, $MIRROR) gets a new owner, MirrorOperator."
print -r -- "   The sandbox OPERATOR key $OPERATOR (held by the hosted relayer) may then ONLY register-and-verify"
print -r -- "   NEW souls, at most $DAILY_CAP per UTC day. It cannot revoke, reassign or touch existing souls."
print -r -- "   The deployer $DEPLOYER owns MirrorOperator: execute(bytes) forwards any mirror call, and"
print -r -- "   transferMirrorOwnership($DEPLOYER) undoes this change."
print -r -- "   ************************************************************************************************"
op_env=(PRIVATE_KEY=${DEPLOYER_KEY:-} OPERATOR=$OPERATOR DAILY_CAP=$DAILY_CAP TRANSFER_MIRROR=1 MIRROR=$MIRROR)
[[ -n $MIRROR_OPERATOR ]] && op_env+=(MIRROR_OPERATOR=$MIRROR_OPERATOR)
if [[ -n $MIRROR_OPERATOR && $(cast call $MIRROR_OPERATOR "isOperator(address)(bool)" $OPERATOR -r $WC_RPC) == true \
      && $(cast call $MIRROR_OPERATOR "dailyCap()(uint256)" -r $WC_RPC | first) == $DAILY_CAP ]]; then
  info "MirrorOperator $MIRROR_OPERATOR already owns the mirror with $OPERATOR whitelisted (cap $DAILY_CAP): nothing to do"
elif [[ $DRY_RUN == 1 ]]; then
  if [[ -n $DEPLOYER_KEY ]]; then
    sim=$(cd $C && env $op_env forge script script/DeployMirrorOperator.s.sol --rpc-url $WC_RPC 2>&1) || die "MirrorOperator simulation failed: ${sim[-400,-1]}"
    info "simulated: $(print -r -- $sim | grep -E 'MirrorOperator|mirror owner' | tr -s ' ' | paste -sd' ' -)"
  else
    info "DRY RUN would deploy MirrorOperator (cap $DAILY_CAP), whitelist $OPERATOR and transfer the mirror to it"
  fi
else
  out=$(cd $C && env $op_env forge script script/DeployMirrorOperator.s.sol --rpc-url $WC_RPC --broadcast --slow 2>&1) || die "MirrorOperator deploy failed: ${out[-400,-1]}"
  MIRROR_OPERATOR=$(print -r -- $out | grep -oE 'MirrorOperator 0x[0-9a-fA-F]{40}' | tail -1 | awk '{print $2}')
  [[ -n $MIRROR_OPERATOR ]] || die "could not read the MirrorOperator address"
  run=$C/broadcast/DeployMirrorOperator.s.sol/1874/run-latest.json
  for h in $(jq -r '.receipts[].transactionHash' $run 2>/dev/null); do record whitechain "MirrorOperator deploy/setup" $h; done
  NONCE[whitechain]=
  [[ ${(L)$(cast call $MIRROR "owner()(address)" -r $WC_RPC)} == ${(L)MIRROR_OPERATOR} ]] || die "mirror owner is not MirrorOperator after the transfer"
  [[ $(cast call $MIRROR_OPERATOR "isOperator(address)(bool)" $OPERATOR -r $WC_RPC) == true ]] || die "operator not whitelisted"
  MIRROR_VIA=$MIRROR_OPERATOR
fi
pass "MirrorOperator ${MIRROR_OPERATOR:-<deployed on send>} owns the mirror; operator $OPERATOR whitelisted (cap $DAILY_CAP/day)"

# ---- 5: TazorAccounts v2 (Whitechain)

step 5 "TazorAccounts v2: the sandbox buyer and \"Sandbox Supplier\""
company() {   # <name> <salt> <admin AA> <executors> -> COMPANY_OUT
  local name=$1 salt=$2 admin=$3 executors=$4
  if [[ -z $REGISTRY || -z $DEPLOYER_KEY ]]; then info "DRY RUN would create $name (salt $salt, admin $admin, executors $executors)"; COMPANY_OUT=""; return 0; fi
  local cenv=(
    VERSION=2 EXECUTORS=$executors FINANCING_MODULE=$FM ADMINS=$admin THRESHOLD=1 REGISTRY=$REGISTRY
    TWO_APPROVER_THRESHOLD=500000 PER_PAYMENT_LIMIT=1000000 MONTHLY_LIMIT=10000000 PAYEE_DELAY=60
    FRESH_THRESHOLD=1000000 MAX_CACHE_AGE=7200 AGENT_MONTHLY_CAP=1000000 EXIT_ACCOUNTS=$DEPLOYER EXIT_DELAY=120
    SALT=$salt PRIVATE_KEY=$DEPLOYER_KEY
  )
  local sim acct
  sim=$(cd $C && env $cenv forge script script/CreateCompany.s.sol --rpc-url $WC_RPC 2>&1) || die "$name simulation failed: ${sim[-400,-1]}"
  acct=$(print -r -- $sim | grep -oE 'TazorAccount \(v2\) 0x[0-9a-fA-F]{40}' | awk '{print $3}')
  [[ -n $acct ]] || die "could not read the $name address"
  COMPANY_OUT=$acct
  [[ $(cast code $acct -r $WC_RPC) != 0x ]] && { info "$name $acct exists"; return 0; }
  if [[ $DRY_RUN == 1 ]]; then info "DRY RUN would create $name $acct"; return 0; fi
  local out
  out=$(cd $C && env $cenv forge script script/CreateCompany.s.sol --rpc-url $WC_RPC --broadcast --slow 2>&1) || die "$name create failed: ${out[-400,-1]}"
  NONCE[whitechain]=
  record whitechain "create $name" $(jq -r '.receipts[-1].transactionHash' $C/broadcast/CreateCompany.s.sol/1874/run-latest.json)
  [[ $(cast code $acct -r $WC_RPC) != 0x ]] || die "no code at $acct"
  info "$name $acct"
}
company sandbox $SANDBOX_SALT $ADMIN_AA payment,mandate,financing; SANDBOX_ACCOUNT=$COMPANY_OUT
company "Sandbox Supplier" $SUPPLIER_SALT $SUPPLIER_AA payment; SANDBOX_SUPPLIER=$COMPANY_OUT
pass "sandbox ${SANDBOX_ACCOUNT:-<on send>} · supplier ${SANDBOX_SUPPLIER:-<on send>} (1 USDT per payment, 10/month, 2 approvers > 0.5 USDT)"

# ---- 6: funding (top-ups only)

step 6 "funding: sandbox 15 USDT; operator 0.3 WBT + 0.05 Sepolia ETH; demo EOAs 0.1 WBT each; financier 2 USDT"
topup_usdt() {   # <name> <addr> <target base units>
  [[ -n $2 ]] || { info "DRY RUN would top $1 up to $(cast from-wei $3 mwei) USDT"; return 0; }
  local have=$(usdt_of $2)
  ge $have $3 && { info "$1 holds $(cast from-wei $have mwei) USDT"; return 0; }
  ge $dep_usdt $(( $3 - have )) || die "deployer has $(cast from-wei $dep_usdt mwei) USDT, needs $(cast from-wei $(( $3 - have )) mwei) for $1"
  send whitechain "fund $1 $(cast from-wei $(( $3 - have )) mwei) USDT" $USDT "transfer(address,uint256)" $2 $(( $3 - have ))
}
topup_native() {   # <chain> <name> <addr> <target ether>
  local rpc=$([[ $1 == sepolia ]] && print $SEPOLIA_RPC || print $WC_RPC)
  local have=$(cast balance $3 -r $rpc) want=$(cast to-wei $4)
  ge $have $want && { info "$2 holds $(cast from-wei $have) on $1"; return 0; }
  send_value $1 "fund $2 $(cast from-wei $(print "$want - $have" | bc)) native ($1)" $3 $(print "$want - $have" | bc)
}
topup_usdt sandbox "$SANDBOX_ACCOUNT" 15000000
topup_usdt financier $FINANCIER 2000000
topup_native whitechain operator $OPERATOR 0.3
topup_native sepolia operator $OPERATOR 0.05
topup_native whitechain "admin EOA" $ADMIN_EOA 0.1
topup_native whitechain "Ravi EOA" $RAVI_EOA 0.1
topup_native whitechain "supplier signer EOA" $SUPPLIER_EOA 0.1
topup_native whitechain "financier EOA" $FINANCIER 0.1
pass "funded (top-ups only)"

# ---- 7: ENS records (Sepolia)

step 7 "ENS records for $LABEL.taz0r.eth (name, tazor.role buyer, ENSIP-11 Whitechain address)"
if [[ -z $SANDBOX_ACCOUNT ]]; then
  info "DRY RUN would set name, description, url, tazor.role=buyer and addr(0x80000752)=<sandbox account> on $LABEL.taz0r.eth"
else
  plan=$(jq -nc --arg l $LABEL --arg a $SANDBOX_ACCOUNT '{label: $l, whitechainAccount: $a, members: [],
    texts: {name: "Sandbox Co.", description: "Public sandbox buyer for Tazor Autopilot (Whitechain Sepolia testnet; tiny limits)", url: "https://tazor-app.vercel.app", "tazor.role": "buyer"}}')
  if [[ $DRY_RUN == 1 ]]; then
    (cd $ROOT/packages/ens && COMPANY_PLAN=$plan SIGNER=$DEPLOYER SEPOLIA_RPC=$SEPOLIA_RPC node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/set-records.ts) | sed 's/^/   /'
  else
    out=$(cd $ROOT/packages/ens && COMPANY_PLAN=$plan PRIVATE_KEY=$DEPLOYER_KEY SEPOLIA_RPC=$SEPOLIA_RPC node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/set-records.ts --send 2>&1) \
      || die "set-records failed: ${out[-400,-1]}"
    print -r -- $out | sed 's/^/   /'
    for h in ${(f)"$(print -r -- $out | grep -oE 'tx 0x[0-9a-f]{64}' | awk '{print $2}')"}; do record sepolia "ENS record" $h; done
    NONCE[sepolia]=
  fi
fi
pass "records $([[ $DRY_RUN == 1 ]] && print planned || print set)"

# ---- 8: roles synced to Whitechain

step 8 "role sync: admin, Ravi and supplier signer roles cached on Whitechain (relayer /sync, else local proof)"
SYNC_NOTE=""
cached() { cast call $ROLE_CACHE "rolesOf(address,address)(uint256,uint64)" $REGISTRY $1 -r $WC_RPC | head -1 | first }
has_bits() { local r=$1 b; for b in ${=2}; do has_bit $r $b || return 1; done }   # <uint> "<bit> <bit>…"
local_sync() {   # <aa>: wait until Whitechain's view of Ethereum includes the ENS roles, prove locally, send syncRoles
  local a=$1 known i ens_then
  for i in {1..40}; do
    known=$(cast call $L1BLOCK "number()(uint64)" -r $WC_RPC | first)
    ens_then=$(cast call $REGISTRY "roles(uint256,address)(uint256)" 0 $a --block $known -r $SEPOLIA_RPC 2>/dev/null | first)
    (( known >= ENS_BLOCK )) && [[ -n $ens_then ]] && has_bits $ens_then "${NEED_BITS[$a]}" && break
    info "Whitechain knows L1 block $known; the roles there are not complete yet (bits ${NEED_BITS[$a]}); waiting 15 s"; sleep 15
  done
  info "proving locally: $PROVER_CMD $REGISTRY $a"
  local proof=$(cd $ROOT && ${=PROVER_CMD} $REGISTRY $a 2>/dev/null | tail -1)
  [[ $proof == 0x* ]] || die "local prover printed no proof"
  send whitechain "syncRoles $a (local proof)" $ROLE_CACHE "syncRoles(address,address,bytes)" $REGISTRY $a $proof
}
if [[ -z $REGISTRY || $DRY_RUN == 1 ]]; then
  info "DRY RUN would POST $RELAYER_URL/sync {registry, account} for $ADMIN_AA, $RAVI_AA and $SUPPLIER_AA until RoleCache holds bits 64(+68)"
  info "   (if the relayer answers not-watched: prove with '$PROVER_CMD' and send RoleCache.syncRoles from the deployer)"
else
  for a in $ADMIN_AA $RAVI_AA $SUPPLIER_AA; do
    has_bits $(cached $a) "${NEED_BITS[$a]}" && { info "$a: bits ${NEED_BITS[$a]} already cached"; continue; }
    for i in {1..12}; do
      relayer POST /sync "$(jq -nc --arg r $REGISTRY --arg a $a '{registry: $r, account: $a}')"
      st=$([[ $RELAYER_STATUS == 200 ]] && print -r -- $RELAYER_BODY | jq -r .status || print "http-$RELAYER_STATUS")
      if [[ $st == not-watched || $st == http-* ]]; then
        SYNC_NOTE="the relayer did not sync the sandbox registry ($st); synced locally"
        local_sync $a
      else
        tx=$(print -r -- $RELAYER_BODY | jq -r '.tx // empty'); [[ -n $tx ]] && record whitechain "syncRoles $a (relayer)" $tx
      fi
      has_bits $(cached $a) "${NEED_BITS[$a]}" && break
      info "status $st; RoleCache does not hold bits ${NEED_BITS[$a]} yet (Whitechain lags Ethereum by about a minute); retrying in 15 s"
      sleep 15
    done
    has_bits $(cached $a) "${NEED_BITS[$a]}" || die "RoleCache still lacks bits ${NEED_BITS[$a]} for $a"
    info "$a: bits ${NEED_BITS[$a]} cached on Whitechain"
  done
fi
pass "roles synced${SYNC_NOTE:+ ($SYNC_NOTE)}"

# ---- 9: Sandbox Supplier as a payee

step 9 "payees: Sandbox Supplier for the sandbox (admin approves) and the sandbox for Sandbox Supplier (credit notes)"
add_payee() {   # <label> <account> <payee> <admin AA> <admin key> <admin EOA>
  local label=$1 acct=$2 payee=$3 aa=$4 key=$5 eoa=$6 added d th digest sig
  added=$(cast call $PM2 "payeeAddedAt(address,address)(uint64)" $acct $payee -r $WC_RPC | first)
  [[ $added != 0 ]] && { info "$label: already added at $added"; return 0; }
  d=$(( $(date +%s) + 3600 ))
  th=$(cast call $PM2 "ADD_PAYEE_TYPEHASH()(bytes32)" -r $WC_RPC)
  digest=$(cast call $PM2 "typedDigest(bytes32)(bytes32)" $(cast keccak $(cast abi-encode "f(bytes32,address,address,uint256)" $th $acct $payee $d)) -r $WC_RPC)
  sig=$(approval $key $eoa $digest)
  send whitechain "addPayee $label" $PM2 "addPayee(address,address,address,uint256,bytes)" $acct $payee $aa $d $sig
}
if [[ -z $SANDBOX_ACCOUNT || -z $SANDBOX_SUPPLIER ]]; then
  info "DRY RUN would addPayee(sandbox → Sandbox Supplier) signed by the admin, and addPayee(Sandbox Supplier → sandbox) signed by the supplier signer"
else
  add_payee "Sandbox Supplier (for the sandbox)" $SANDBOX_ACCOUNT $SANDBOX_SUPPLIER $ADMIN_AA $(hexkey $SANDBOX_ADMIN_KEY) $ADMIN_EOA
  add_payee "sandbox (for Sandbox Supplier: credit notes)" $SANDBOX_SUPPLIER $SANDBOX_ACCOUNT $SUPPLIER_AA $(hexkey $SANDBOX_SUPPLIER_KEY) $SUPPLIER_EOA
fi
pass "payees added both ways (each payable after the 60 s payee delay)"

# ---- 10: one mandate and one listed financing claim

step 10 "a mandate (sandbox → Sandbox Supplier) and a financing claim listed for the financier"
MM2=$(jqa $WC_JSON .MandateModuleV2)
PREV_MANDATE="" PREV_CLAIM=""
[[ -f $ROOT/scripts/sandbox/setup.json ]] && { PREV_MANDATE=$(jqa $ROOT/scripts/sandbox/setup.json .relayerConfig.SANDBOX_MANDATE_ID); PREV_CLAIM=$(jqa $ROOT/scripts/sandbox/setup.json .relayerConfig.SANDBOX_CLAIM_ID); }
MANDATE_ID="" CLAIM_ID=""
send_as() {   # <key> <label> <to> <sig> [args...]: one tx from a demo EOA (the claim holder lists its own claim)
  local key=$1 label=$2 to=$3; shift 3
  if [[ $DRY_RUN == 1 ]]; then info "DRY RUN would send on whitechain from a demo EOA: $label → $to $1"; return 0; fi
  local out
  out=$(cast send $to "$@" --private-key $key -r $WC_RPC --json 2>&1) || die "$label failed: ${out[1,300]}"
  LAST_TX=$(print -r -- $out | jq -r .transactionHash)
  [[ $(print -r -- $out | jq -r .status) == 0x1 ]] || die "$label reverted: $LAST_TX"
  record whitechain "$label" $LAST_TX
  info "$label  $WC_TX/$LAST_TX"
}
if [[ -z $SANDBOX_ACCOUNT || -z $SANDBOX_SUPPLIER || $DRY_RUN == 1 && -z $REGISTRY ]]; then
  info "DRY RUN would createMandate(sandbox → Sandbox Supplier, 0.5 USDT / 30 days, 90 days) approved by the admin"
  info "DRY RUN would commit a 0.4 USDT claim on the sandbox (holder = supplier signer EOA, due in 7 days), then list it at 0.38 USDT"
else
  # the payee rule: wait out the 60 s payee delay first
  added=$(cast call $PM2 "payeeAddedAt(address,address)(uint64)" $SANDBOX_ACCOUNT $SANDBOX_SUPPLIER -r $WC_RPC | first)
  while (( added > 0 && $(cast block latest --field timestamp -r $WC_RPC) < added + 60 )); do info "payee delay: waiting 10 s"; sleep 10; done
  zero_word() { [[ $1 =~ '^0x0*$' ]] }
  if [[ -n $PREV_MANDATE ]] && ! zero_word "$(cast call $MM2 "mandateOf(bytes32)" $PREV_MANDATE -r $WC_RPC | cut -c1-66)"; then
    MANDATE_ID=$PREV_MANDATE; info "mandate $MANDATE_ID exists"
  else
    MT="(address,address,uint256,uint64,uint64,uint256)"
    m="($SANDBOX_ACCOUNT,$SANDBOX_SUPPLIER,500000,2592000,$(( $(date +%s) + 90 * 86400 )),$(( $(date +%s) * 1000 + 1 )))"
    MANDATE_ID=$(cast call $MM2 "mandateDigest($MT)(bytes32)" "$m" -r $WC_RPC)
    send whitechain "createMandate 0.5 USDT / 30 days" $MM2 "createMandate($MT,address[],bytes[])" "$m" "[$ADMIN_AA]" "[$(approval $(hexkey $SANDBOX_ADMIN_KEY) $ADMIN_EOA $MANDATE_ID)]"
  fi
  if [[ -n $PREV_CLAIM ]] && cast call $FM "ownerOf(uint256)(address)" $PREV_CLAIM -r $WC_RPC >/dev/null 2>&1; then
    CLAIM_ID=$PREV_CLAIM; info "claim $CLAIM_ID exists"
  else
    FT="(bytes32,address,address,uint256,uint64,uint256)"
    f="($(cast keccak "tazor sandbox financed $(date +%s)"),$SANDBOX_ACCOUNT,$SUPPLIER_EOA,400000,$(( $(date +%s) + 7 * 86400 )),$(( $(date +%s) * 1000 + 2 )))"
    fd=$(cast call $FM "financedDigest($FT)(bytes32)" "$f" -r $WC_RPC)
    send whitechain "commit claim 0.4 USDT (holder = supplier signer)" $FM "commit($FT,address[],bytes[])" "$f" "[$ADMIN_AA]" "[$(approval $(hexkey $SANDBOX_ADMIN_KEY) $ADMIN_EOA $fd)]"
    CLAIM_ID=$(cast to-dec $fd)
  fi
  if [[ $DRY_RUN != 1 ]]; then
    holder=$(cast call $FM "ownerOf(uint256)(address)" $CLAIM_ID -r $WC_RPC)
    listed=$(cast call $FM "listings(uint256)(uint256)" $CLAIM_ID -r $WC_RPC | first)
    if [[ $listed == 0 && ${(L)holder} == ${(L)SUPPLIER_EOA} ]]; then
      send_as $(hexkey $SANDBOX_SUPPLIER_KEY) "list claim at 0.38 USDT (supplier signer)" $FM "list(uint256,uint256)" $CLAIM_ID 380000
    else
      info "claim $CLAIM_ID held by $holder, listed at $listed"
    fi
  fi
fi
pass "mandate ${MANDATE_ID:-<on send>} · claim ${CLAIM_ID:-<on send>}"

# ---- output

relayer_cfg=$(jq -nc --arg acct "${SANDBOX_ACCOUNT:-}" --arg reg "${REGISTRY:-}" --arg sup "${SANDBOX_SUPPLIER:-}" --arg mo "${MIRROR_OPERATOR:-}" \
  --arg op $OPERATOR --arg admin "${ADMIN_AA:-}" --arg ravi "${RAVI_AA:-}" --arg ss "${SUPPLIER_AA:-}" --arg fin $FINANCIER \
  --arg finaa "${FINANCIER_AA:-}" --arg mid "${MANDATE_ID:-}" --arg cid "${CLAIM_ID:-}" \
  '{SANDBOX_ACCOUNT: $acct, SANDBOX_REGISTRY: $reg, SANDBOX_SUPPLIER: $sup, MIRROR_OPERATOR: $mo, SANDBOX_OPERATOR: $op,
    SANDBOX_ADMIN_ACCOUNT: $admin, SANDBOX_RAVI_ACCOUNT: $ravi, SANDBOX_SUPPLIER_SIGNER_ACCOUNT: $ss,
    SANDBOX_FINANCIER: $fin, SANDBOX_FINANCIER_ACCOUNT: $finaa, SANDBOX_MANDATE_ID: $mid, SANDBOX_CLAIM_ID: $cid}')
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson dry $([[ $DRY_RUN == 1 ]] && print true || print false) --arg label "$LABEL.taz0r.eth" \
  --argjson relayer "$relayer_cfg" --arg mirror $MIRROR --arg deployer $DEPLOYER --argjson cap $DAILY_CAP \
  --arg adminEoa $ADMIN_EOA --arg raviEoa $RAVI_EOA --arg supEoa $SUPPLIER_EOA \
  --argjson txs "[${(j:,:)TXS}]" '{
    at: $at, dryRun: $dry, name: $label, deployer: $deployer,
    relayerConfig: $relayer,
    signers: {adminEoa: $adminEoa, raviEoa: $raviEoa, supplierSignerEoa: $supEoa},
    limits: {perPayment: "1 USDT", monthly: "10 USDT", agentMonthly: "1 USDT", twoApproversAbove: "0.5 USDT", payeeDelaySeconds: 60, exitDelaySeconds: 120},
    mirror: {address: $mirror, operatorContract: $relayer.MIRROR_OPERATOR, dailyCap: $cap},
    txs: $txs}' > $OUT

print_summary
print; print -r -- "== Recorded in ${OUT#$ROOT/}"
print -r -- "$relayer_cfg" | jq .
print; print -r -- "== For the hosted relayer (run in your shell after: set -a; source .env.local; set +a; values are NOT printed here)"
print -r -- '   vercel env rm WATCH_REGISTRIES production -y   # then re-add it with the sandbox registry appended:'
print -r -- "   print -rn -- \"<current WATCH_REGISTRIES>,${REGISTRY:-<sandbox registry>}\" | vercel env add WATCH_REGISTRIES production"
for v in SANDBOX_OPERATOR_KEY SANDBOX_ADMIN_KEY SANDBOX_RAVI_KEY SANDBOX_SUPPLIER_KEY SANDBOX_FINANCIER_KEY; do
  print -r -- "   print -rn -- \"\$$v\" | vercel env add $v production"
done
for k in SANDBOX_ACCOUNT SANDBOX_REGISTRY SANDBOX_SUPPLIER MIRROR_OPERATOR SANDBOX_MANDATE_ID SANDBOX_CLAIM_ID; do
  print -r -- "   print -rn -- \"$(print -r -- $relayer_cfg | jq -r ".$k")\" | vercel env add $k production"
done
print; print -r -- "RESULT: PASS$([[ $DRY_RUN == 1 ]] && print ' (dry run: nothing was sent and no keys were written)')"
