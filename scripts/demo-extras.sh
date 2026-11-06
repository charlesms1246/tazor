#!/usr/bin/env zsh
# Tazor extras live demo, driving the LIVE relayer: payment runs (v1 + v2), a paymaster-sponsored userOp,
# the paymaster's no-soul refusal, and an ERC-6492 counterfactual approver paid through the relayer.
# Stops at the first FAIL; every tx is recorded in $RUN_JSON (default scripts/demo-extras/last-run.json, not
# written in DRY_RUN) for scripts/verify-live.sh section 8.
#
# Keys come only from the environment (never printed); sources $ENV_FILE (default tazor/.env.local) if present:
# PRIVATE_KEY (deployer: funder, WB Soul mirror owner) and PRIYA_KEY (backup EOA of Priya's ApproverAccount).
# Overrides: DEPLOYER_KEY, WC_RPC, RELAYER_URL (default http://localhost:8787), PRIYA_ACCOUNT, PAYMASTER.
# Fresh keys generated here (new backup signers) stay in memory only.
# Needs: cast, jq, curl. cast takes keys via --private-key, so they appear briefly in the local process list.
set -u
setopt pipefail

ROOT=${0:A:h:h}
C=$ROOT/contracts
ENV_FILE=${ENV_FILE:-$ROOT/.env.local}
if [[ -f $ENV_FILE ]]; then set -a; source $ENV_FILE; set +a; fi
for bin in cast jq curl; do command -v $bin >/dev/null || { print -u2 "missing dependency: $bin"; exit 2; }; done

hexkey() { [[ -n ${1:-} ]] && print -r -- "0x${1#0x}" }
DEPLOYER_KEY=$(hexkey ${DEPLOYER_KEY:-${PRIVATE_KEY:-}})
PRIYA_KEY=$(hexkey ${PRIYA_KEY:-})
for k in DEPLOYER_KEY PRIYA_KEY; do [[ -n ${(P)k} ]] || { print -u2 "$k is not set (env or $ENV_FILE)"; exit 2; }; done

DRY_RUN=${DRY_RUN:-0}
WC_RPC=${WC_RPC:-https://rpc.testnet.whitechain.io}
RELAYER_URL=${RELAYER_URL:-http://localhost:8787}
RELAYER_URL=${RELAYER_URL%/}
WC_TX=https://explorer.testnet.whitechain.io/tx
WC_JSON=$C/deployments/1874.json
jqa() { jq -r "$2 // empty" $1 }

PM1=$(jqa $WC_JSON .PaymentModule)
PM2=$(jqa $WC_JSON .PaymentModuleV2)
FACTORY=$(jqa $WC_JSON .ApproverAccountFactory)
MIRROR=$(jqa $WC_JSON .WBSoulMirror)
USDT=$(jqa $WC_JSON .USDT)
EP=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
IS_VERIFIED=0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41
PRIYA=${PRIYA_ACCOUNT:-0x00aBed5bDddf794c415eE746d3E4De5332cC5450}
ACME_V1=0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6
ACME_P2=0xb99A12652BEe98429ae31EA0529A0b63f1073721
BLUEJAY=0xc1dce946D192e344251972470237F1471C93876c
ROLE_APPROVER=$(cast to-dec 0x10000000000000000)
MAGIC=6492649264926492649264926492649264926492649264926492649264926492
T_INVOICE_PAID=$(cast keccak "InvoicePaid(address,uint256,address,uint256,bool)")
T_USEROP=$(cast keccak "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")

DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
PRIYA_EOA=$(cast wallet address --private-key $PRIYA_KEY)

# ---- reporting and recording

RUN_JSON=${RUN_JSON:-$ROOT/scripts/demo-extras/last-run.json}
[[ $DRY_RUN == 1 ]] && RUN_JSON=${RUN_JSON_DRY:-}
typeset -a SUMMARY
STEP=0
step() { STEP=$1; print; print -r -- "== STEP $1: $2" }
info() { print -r -- "   $*" }
pass() { print -r -- "STEP $STEP PASS  $*" }
print_summary() {
  print; print -r -- "== Summary"
  printf '%-5s | %-72s | %9s\n' step tx gas
  for r in $SUMMARY; do local p=("${(@s:|:)r}"); printf '%-5s | %-72s | %9s\n' $p[1] $p[2] $p[3]; done
}
die() { print -r -- "STEP $STEP FAIL  $*"; print_summary; exit 1 }
link() { [[ $DRY_RUN == 1 ]] && print -r -- "$1 (anvil)" || print -r -- "$WC_TX/$1" }
record_tx() {   # <label> <hash>
  [[ -n $RUN_JSON && -f $RUN_JSON ]] || return 0
  jq --argjson step $STEP --arg label "$1" --arg hash $2 '.txs += [{step: $step, label: $label, chain: "whitechain", hash: $hash}]' \
    $RUN_JSON > $RUN_JSON.tmp && mv $RUN_JSON.tmp $RUN_JSON
}
row() {   # <label> <hash>
  local gas=$(cast to-dec $(cast receipt $2 gasUsed -r $WC_RPC 2>/dev/null) 2>/dev/null)
  SUMMARY+=("$STEP|$1 $2|${gas:--}")
  record_tx "$1" $2
}
if [[ -n $RUN_JSON ]]; then
  mkdir -p ${RUN_JSON:h}
  jq -n --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg relayer "$RELAYER_URL" \
    '{startedAt: $started, company: "acme v1 + acme-p2", salt: "extras", relayer: $relayer, txs: []}' > $RUN_JSON
fi

# ---- chain helpers

wc_now() { cast to-dec $(cast block latest --field timestamp -r $WC_RPC) }
usdt_of() { cast call $USDT "balanceOf(address)(uint256)" $1 -r $WC_RPC | awk '{print $1}' }
wait_receipt() {   # <hash> -> receipt json; dies on revert or timeout
  local r
  for i in {1..90}; do
    r=$(cast receipt $1 --json -r $WC_RPC 2>/dev/null) && [[ -n $r ]] && break
    sleep 2
  done
  [[ -n ${r:-} ]] || die "no receipt for $1"
  [[ $(print -r -- $r | jq -r .status) == 0x1 ]] || die "tx reverted: $(link $1)"
  print -r -- $r
}
send_wc() {   # <key> <to> <sig> [args...] -> LAST_TX
  local key=$1 to=$2; shift 2
  local out
  out=$(cast send $to "$@" --private-key $key -r $WC_RPC --json 2>&1) || die "tx failed: ${out[1,300]}"
  [[ $(print -r -- $out | jq -r .status) == 0x1 ]] || die "tx reverted: $(print -r -- $out | jq -r .transactionHash)"
  LAST_TX=$(print -r -- $out | jq -r .transactionHash)
}
mirror_wc() {   # <sig> [args...]: a WB Soul mirror write as the deployer, direct or through MirrorOperator.execute
  local sig=$1; shift
  if [[ -n $MIRROR_VIA ]]; then send_wc $DEPLOYER_KEY $MIRROR_VIA "execute(bytes)" $(cast calldata "$sig" "$@"); else send_wc $DEPLOYER_KEY $MIRROR "$sig" "$@"; fi
}
relayer() {   # <path> <json> -> RELAYER_BODY, RELAYER_STATUS
  local out
  out=$(curl -sS -m 120 -X POST "$RELAYER_URL$1" -H 'content-type: application/json' -d "$2" -w '\n%{http_code}' 2>&1) || die "relayer $1 unreachable at $RELAYER_URL: ${out[1,200]}"
  RELAYER_STATUS=${out##*$'\n'}
  RELAYER_BODY=${out%$'\n'*}
}
sign_raw() { cast wallet sign --no-hash $2 --private-key $1 }
approval() { cast abi-encode "f(bytes[],bytes[])" "[$2]" "[$(sign_raw $1 $3)]" }   # <key> <eoa> <digest>
typed() { cast call $PM2 "typedDigest(bytes32)(bytes32)" $1 -r $WC_RPC }
fresh_key() { cast wallet new --json | jq -r '.[0].private_key' }

AUTH_T="(bytes32,address,address,uint256,uint64,uint256)"
NONCE_BASE=$(( $(date +%s) * 1000 ))
NONCE_I=0
next_nonce() { NONCE_I=$((NONCE_I + 1)); NONCE=$((NONCE_BASE + NONCE_I)) }
# make_run <account> <n> <amount>: sets RUN_TUPLES (cast) and RUN_JSON_AUTHS (relayer), NONCES
make_run() {
  local account=$1 n=$2 amount=$3 exp=$(( $(wc_now) + 86400 )) t=() j="[]"
  NONCES=()
  for i in {1..$n}; do
    next_nonce
    local h=$(cast keccak "tazor demo extras invoice $NONCE")
    t+=("($h,$account,$BLUEJAY,$amount,$exp,$NONCE)")
    j=$(print -r -- $j | jq -c --arg h $h --arg a $account --arg p $BLUEJAY --arg amt $amount --arg e $exp --arg n $NONCE \
      '. + [{invoiceHash: $h, account: $a, payee: $p, amount: $amt, expiry: $e, nonce: $n}]')
    NONCES+=($NONCE)
  done
  RUN_TUPLES="[${(j:,:)t}]"
  RUN_JSON_AUTHS=$j
}
run_digest() { cast call $1 "runDigest(${AUTH_T}[])(bytes32)" "$RUN_TUPLES" -r $WC_RPC }
# expect_paid <module> <receipt json> <account>: every nonce in NONCES has an InvoicePaid on <module>
expect_paid() {
  local module=$1 r=$2 account=$3 n
  for n in $NONCES; do
    local topic=$(cast to-uint256 $n)
    print -r -- $r | jq -e --arg a ${(L)module} --arg t0 $T_INVOICE_PAID --arg acct ${(L)$(cast to-uint256 $account)} --arg t2 ${(L)topic} \
      '[.logs[] | select((.address|ascii_downcase)==$a and .topics[0]==$t0 and (.topics[1]|ascii_downcase)==$acct and (.topics[2]|ascii_downcase)==$t2)] | length == 1' >/dev/null \
      || die "no InvoicePaid for nonce $n on $module"
  done
  info "InvoicePaid on $module for nonces ${(j:, :)NONCES}"
}
# pay_run <module> <account> <approver> <signature> -> PAY_RECEIPT
pay_run() {
  relayer /payrun "$(jq -nc --arg a $2 --argjson auths "$RUN_JSON_AUTHS" --arg ap $3 --arg s $4 '{account: $a, auths: $auths, approvers: [$ap], signatures: [$s]}')"
  [[ $RELAYER_STATUS == 200 ]] || die "relayer /payrun $RELAYER_STATUS: $RELAYER_BODY"
  [[ ${(L)$(print -r -- $RELAYER_BODY | jq -r .paymentModule)} == ${(L)1} ]] || die "relayer chose $(print -r -- $RELAYER_BODY | jq -r .paymentModule), expected $1"
  for d in ${(f)"$(print -r -- $RELAYER_BODY | jq -r '.deployTxs[]?')"}; do
    wait_receipt $d >/dev/null; row "approver deploy (6492)" $d; info "deployed approver  $(link $d)"
  done
  local h=$(print -r -- $RELAYER_BODY | jq -r .txHash)
  PAY_RECEIPT=$(wait_receipt $h)
  row "payRun ${#NONCES}x" $h
  PAY_TX=$h
}

print -r -- "Tazor extras demo  (Whitechain $WC_RPC | relayer $RELAYER_URL)$([[ $DRY_RUN == 1 ]] && print ' DRY RUN')"

# ---- 0. preflight

step 0 "preflight"
health=$(curl -sS -m 10 "$RELAYER_URL/health" 2>/dev/null) || die "relayer not reachable at $RELAYER_URL"
[[ $(print -r -- $health | jq -r .ok) == true ]] || die "relayer /health not ok: $health"
PAYMASTER=${PAYMASTER:-0x5E1a26A8482641E7Cfa3FD6f454845C7Ae3C6686}
info "relayer sender $(print -r -- $health | jq -r .relayer), paymentModule $(print -r -- $health | jq -r .paymentModule), paymaster $PAYMASTER"
[[ ${(L)$(print -r -- $health | jq -r .paymentModule)} == ${(L)PM1} ]] || die "relayer must run with PAYMENT_MODULE=$PM1 (v1)"
[[ $(cast call $PRIYA "isSigner(bytes)(bool)" $PRIYA_EOA -r $WC_RPC) == true ]] || die "PRIYA_KEY is not a signer of $PRIYA"
for v in PM1 PM2 FACTORY MIRROR USDT; do [[ -n ${(P)v} ]] || die "$v missing from deployments"; done
MIRROR_OWNER=$(cast call $MIRROR "owner()(address)" -r $WC_RPC)
MIRROR_VIA=""
if [[ ${(L)MIRROR_OWNER} != ${(L)DEPLOYER} ]]; then   # after setup-sandbox.sh a MirrorOperator owned by the deployer owns the mirror
  [[ ${(L)$(cast call $MIRROR_OWNER "owner()(address)" -r $WC_RPC 2>/dev/null)} == ${(L)DEPLOYER} ]] || die "deployer is not the WB Soul mirror owner nor its MirrorOperator's owner"
  MIRROR_VIA=$MIRROR_OWNER
fi
pass "relayer up; Priya's key matches; deployer owns the mirror"

# ---- 1. payment run v1

step 1 "payment run v1 via relayer /payrun: acme v1 -> bluejay, 2 x 0.1 USDT, one approval"
make_run $ACME_V1 2 100000
pay_run $PM1 $ACME_V1 $PRIYA $(approval $PRIYA_KEY $PRIYA_EOA $(run_digest $PM1))
expect_paid $PM1 "$PAY_RECEIPT" $ACME_V1
pass "2 invoices paid in one tx  $(link $PAY_TX)"

# ---- 2. payment run v2

step 2 "payment run v2 via /payrun: acme-p2 -> bluejay, 2 x 0.1 USDT"
send_wc $DEPLOYER_KEY $USDT "transfer(address,uint256)" $ACME_P2 500000
row "fund acme-p2 0.5 USDT" $LAST_TX
info "funded acme-p2 with 0.5 USDT  $(link $LAST_TX)"
make_run $ACME_P2 2 100000
pay_run $PM2 $ACME_P2 $PRIYA $(approval $PRIYA_KEY $PRIYA_EOA $(run_digest $PM2))
expect_paid $PM2 "$PAY_RECEIPT" $ACME_P2
pass "v2 run paid (limits and payee rule applied by PaymentModuleV2)  $(link $PAY_TX)"

# ---- 3. sponsored userOp

step 3 "sponsored userOp: Priya's ApproverAccount adds a new backup signer, paying no gas"
NEW_KEY=$(fresh_key); NEW_EOA=$(cast wallet address --private-key $NEW_KEY); unset NEW_KEY
[[ $(cast call $PRIYA "isSigner(bytes)(bool)" $NEW_EOA -r $WC_RPC) == false ]] || die "new signer already present"
bal_before=$(cast balance $PRIYA -r $WC_RPC)
dep_before=$(cast call $EP "balanceOf(address)(uint256)" $PAYMASTER -r $WC_RPC | awk '{print $1}')
inner=$(cast calldata "addSigners(bytes[])" "[$NEW_EOA]")
exec_data=$(cast abi-encode "f((address,uint256,bytes)[])" "[($PRIYA,0,$inner)]")
CALLDATA=$(cast calldata "execute(bytes32,bytes)" 0x0100000000000000000000000000000000000000000000000000000000000000 $exec_data)
NONCE_OP=$(cast call $EP "getNonce(address,uint192)(uint256)" $PRIYA 0 -r $WC_RPC | awk '{print $1}')
gp=$(cast gas-price -r $WC_RPC)
MAX_FEE=$(( gp * 2 + 1000000 )); PRIO=$(( gp < 1000000 ? gp : 1000000 ))
op=$(jq -nc --arg s $PRIYA --arg n $(cast to-hex $NONCE_OP) --arg c $CALLDATA --arg mf $(cast to-hex $MAX_FEE) --arg mp $(cast to-hex $PRIO) \
  '{sender: $s, nonce: $n, callData: $c, maxFeePerGas: $mf, maxPriorityFeePerGas: $mp}')
relayer /rpc "$(jq -nc --argjson op "$op" --arg ep $EP --arg c $(cast to-hex $(cast chain-id -r $WC_RPC)) '{jsonrpc: "2.0", id: 1, method: "pm_getPaymasterData", params: [$op, $ep, $c, {}]}')"
pmr=$(print -r -- $RELAYER_BODY | jq -c '.result // empty')
[[ -n $pmr ]] || die "paymaster refused: $RELAYER_BODY"
op=$(print -r -- $op | jq -c --argjson p "$pmr" '. + ($p | del(.isFinal))')
u128() { printf '%032x' $(cast to-dec $1) }
f() { print -r -- $op | jq -r ".$1" }
acct_gas="0x$(u128 $(f verificationGasLimit))$(u128 $(f callGasLimit))"
fees="0x$(u128 $(f maxPriorityFeePerGas))$(u128 $(f maxFeePerGas))"
pmdata=$(f paymasterData)
pmad="$(f paymaster)$(u128 $(f paymasterVerificationGasLimit))$(u128 $(f paymasterPostOpGasLimit))${pmdata#0x}"
packed="($PRIYA,$NONCE_OP,0x,$CALLDATA,$acct_gas,$(cast to-dec $(f preVerificationGas)),$fees,$pmad,0x)"
OP_HASH=$(cast call $EP "getUserOpHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))(bytes32)" "$packed" -r $WC_RPC)
info "userOpHash $OP_HASH (paymaster $(f paymaster))"
op=$(print -r -- $op | jq -c --arg sig $(approval $PRIYA_KEY $PRIYA_EOA $OP_HASH) '. + {signature: $sig}')
relayer /userop "$(jq -nc --argjson op "$op" '{userOp: $op}')"
[[ $RELAYER_STATUS == 200 ]] || die "relayer /userop $RELAYER_STATUS: $RELAYER_BODY"
UOP_TX=$(print -r -- $RELAYER_BODY | jq -r .txHash)
r=$(wait_receipt $UOP_TX)
row "handleOps (sponsored addSigners)" $UOP_TX
ev=$(print -r -- $r | jq -c --arg t $T_USEROP '[.logs[] | select(.topics[0]==$t)][0] // empty')
[[ -n $ev ]] || die "no UserOperationEvent"
evdata=$(print -r -- $ev | jq -r .data)
[[ $(cast to-dec 0x${evdata[67,130]}) == 1 ]] || die "userOp executed but failed (UserOperationEvent.success == false)"
[[ $(cast call $PRIYA "isSigner(bytes)(bool)" $NEW_EOA -r $WC_RPC) == true ]] || die "new signer not added"
bal_after=$(cast balance $PRIYA -r $WC_RPC)
dep_after=$(cast call $EP "balanceOf(address)(uint256)" $PAYMASTER -r $WC_RPC | awk '{print $1}')
[[ $bal_after == $bal_before ]] || die "Priya's account balance changed ($bal_before -> $bal_after)"
(( dep_before > dep_after )) || die "paymaster deposit did not drop ($dep_before -> $dep_after)"
info "new signer $NEW_EOA added; account balance $bal_after wei (unchanged); paymaster deposit $dep_before -> $dep_after"
pass "sponsored: the EntryPoint deposit paid, Priya paid nothing  $(link $UOP_TX)"

# ---- 4. paymaster refusal

step 4 "paymaster refuses an ApproverAccount with no WB Soul"
NOSOUL_KEY=$(fresh_key); NOSOUL_EOA=$(cast wallet address --private-key $NOSOUL_KEY); unset NOSOUL_KEY
relayer /approver "$(jq -nc --arg s $NOSOUL_EOA '{signer: $s}')"
[[ $RELAYER_STATUS == 200 ]] || die "relayer /approver $RELAYER_STATUS: $RELAYER_BODY"
NOSOUL=$(print -r -- $RELAYER_BODY | jq -r .account)
d=$(print -r -- $RELAYER_BODY | jq -r '.txHash // empty')
[[ -n $d ]] && { wait_receipt $d >/dev/null; row "deploy soul-less approver" $d; info "deployed $NOSOUL  $(link $d)"; }
op=$(jq -nc --arg s $NOSOUL '{sender: $s, nonce: "0x0", callData: "0x"}')
relayer /rpc "$(jq -nc --argjson op "$op" --arg ep $EP --arg c $(cast to-hex $(cast chain-id -r $WC_RPC)) '{jsonrpc: "2.0", id: 2, method: "pm_getPaymasterStubData", params: [$op, $ep, $c, {}]}')"
code=$(print -r -- $RELAYER_BODY | jq -r '.error.code // empty'); message=$(print -r -- $RELAYER_BODY | jq -r '.error.message // empty')
[[ $code == -32000 && $message == *"not bound to a verified WB Soul"* ]] || die "expected -32000 'not bound to a verified WB Soul', got: $RELAYER_BODY"
pass "refused: $code \"$message\" (drain guard)"

# ---- 5. ERC-6492 live

step 5 "ERC-6492: a counterfactual approver, soul-bound and granted, paid through the relayer"
CF_KEY=$(fresh_key); CF_EOA=$(cast wallet address --private-key $CF_KEY)
CF=$(cast call $FACTORY "predictAddress(bytes[])(address)" "[$CF_EOA]" -r $WC_RPC)
[[ $(cast code $CF -r $WC_RPC) == 0x ]] || die "$CF already deployed"
info "counterfactual approver $CF (not deployed)"
mirror_wc "registerSoul(address)" $CF; row "registerSoul (counterfactual)" $LAST_TX
soul=$(cast call $MIRROR "soulOf(address)(uint256)" $CF -r $WC_RPC | awk '{print $1}')
mirror_wc "setAttribute(uint256,address,bytes20)" $soul $IS_VERIFIED 0x0000000000000000000000000000000000000001
row "IsVerified (counterfactual)" $LAST_TX
info "bound to soul $soul and verified (simulated WB Soul mirror)"
vu=$(( $(wc_now) + 540 )); dl=$(( $(wc_now) + 3600 ))
gsig=$(approval $PRIYA_KEY $PRIYA_EOA $(typed $(cast keccak $(cast abi-encode "f(bytes32,address,address,uint256,uint64,uint256)" \
  $(cast call $PM2 "PROVISIONAL_GRANT_TYPEHASH()(bytes32)" -r $WC_RPC) $ACME_P2 $CF $ROLE_APPROVER $vu $dl))))
send_wc $DEPLOYER_KEY $PM2 "provisionalGrant(address,address,uint256,uint64,address,uint256,bytes)" $ACME_P2 $CF $ROLE_APPROVER $vu $PRIYA $dl $gsig
row "provisionalGrant (Priya -> counterfactual)" $LAST_TX
info "provisional APPROVER on acme-p2 until $vu"
make_run $ACME_P2 1 100000
inner=$(approval $CF_KEY $CF_EOA $(run_digest $PM2)); unset CF_KEY
wrapped="$(cast abi-encode "f(address,bytes,bytes)" $FACTORY $(cast calldata "createAccount(bytes[])" "[$CF_EOA]") $inner)$MAGIC"
pay_run $PM2 $ACME_P2 $CF $wrapped
[[ $(cast code $CF -r $WC_RPC) != 0x ]] || die "the relayer did not deploy $CF"
expect_paid $PM2 "$PAY_RECEIPT" $ACME_P2
pass "relayer deployed $CF from the ERC-6492 wrapper, then paid  $(link $PAY_TX)"

print_summary
print; print -r -- "ALL STEPS PASS"
