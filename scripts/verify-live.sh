#!/usr/bin/env zsh
# Read-only check of every live Tazor claim. Needs: cast (Foundry), jq, curl, bc.
# Env: WC_RPC (Whitechain Sepolia), SEPOLIA_RPC (archive-capable Ethereum Sepolia).
# Exits non-zero if any check fails. Sends no transactions.
set -u
setopt pipefail

ROOT=${0:A:h:h}
WC_RPC=${WC_RPC:-https://rpc.testnet.whitechain.io}
SEPOLIA_RPC=${SEPOLIA_RPC:-https://sepolia.gateway.tenderly.co}
BLOCKSCOUT=${BLOCKSCOUT:-https://explorer.testnet.whitechain.io/api/v2}
SOURCIFY=${SOURCIFY:-https://sourcify.dev/server/v2}
WC_JSON=$ROOT/contracts/deployments/1874.json
L1_JSON=$ROOT/contracts/deployments/11155111.json

for bin in cast jq curl bc; do
  command -v $bin >/dev/null || { print -u2 "missing dependency: $bin"; exit 2; }
done

typeset -i passes=0 fails=0
pass() { print -r -- "PASS  $1"; passes+=1 }
fail() { print -r -- "FAIL  $1"; fails+=1 }
section() { print; print -r -- "== $1" }
lc() { print -r -- ${(L)1} }
# expect <label> <actual> <expected>   (case-insensitive)
expect() { [[ $(lc $2) == $(lc $3) ]] && pass "$1: $2" || fail "$1: got $2, expected $3" }
# word <hexdata> <index> -> 0x-prefixed 32-byte word
word() { print -r -- "0x${1:$((2 + 64 * $2)):64}" }
addr_of_word() { print -r -- "0x${1[27,66]}" }
dec() { cast to-dec $1 }
alias_l1_to_l2() {
  local h=${(U)1#0x}
  local s=$(print "obase=16; ibase=16; (${h} + 1111000000000000000000000000000000001111) % 10000000000000000000000000000000000000000" | bc | tr -d '\\\n')
  cast to-check-sum-address 0x${(l:40::0:)s}
}
addr() { jq -r "$2" $1 }
call() { cast call "$@" 2>/dev/null | head -1 | awk '{print $1}' }
receipt() { cast receipt $2 --json -r $1 2>/dev/null }
# log_of <receipt-json> <emitter> <topic0> -> first matching log as json
log_of() { print -r -- $1 | jq -c --arg a $(lc $2) --arg t $(lc $3) '[.logs[] | select((.address|ascii_downcase)==$a and (.topics[0]|ascii_downcase)==$t)][0] // empty' }

PM=$(addr $WC_JSON .PaymentModule)
MM=$(addr $WC_JSON .MandateModule)
RC=$(addr $WC_JSON .RoleCache)
RL=$(addr $WC_JSON .RevocationList)
USDT=$(addr $WC_JSON .USDT)
GATE=$(addr $L1_JSON .EnsGate)
PORTAL=$(addr $L1_JSON .OptimismPortal)
ETH_REGISTRY=$(addr $L1_JSON .ENS.ETHRegistry)
TAZ0R_REGISTRY=$(addr $L1_JSON .ENS.taz0rSubregistry)
ACME_REGISTRY=0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1
BLUEJAY_REGISTRY=0x2A582b9cFD4C20921C467512B7ebA41204d9a16b
TAZ0R_OWNER=0xce4389ACb79463062c362fACB8CB04513fA3D8D8

T_INVOICE_PAID=$(cast keccak "InvoicePaid(address,uint256,address,uint256,bool)")
T_TRANSFER=$(cast keccak "Transfer(address,address,uint256)")
T_DEPOSITED=$(cast keccak "TransactionDeposited(address,address,uint256,bytes)")
T_ROLES_SYNCED=$(cast keccak "RolesSynced(address,address,uint256,uint64)")
T_REVOKED=$(cast keccak "ApproverRevoked(address,address,address)")
T_MANDATE_CREATED=$(cast keccak "MandateCreated(bytes32,address,address,uint256,uint64,uint64)")
T_MANDATE_PULLED=$(cast keccak "MandatePulled(bytes32,uint256,uint256)")

print -r -- "Tazor live verification  (Whitechain Sepolia: $WC_RPC | Ethereum Sepolia: $SEPOLIA_RPC)"
expect "Whitechain chain id" $(cast chain-id -r $WC_RPC) 1874
expect "Ethereum Sepolia chain id" $(cast chain-id -r $SEPOLIA_RPC) 11155111

# ---------------------------------------------------------------------------
section "1. Code and source verification"
for key in ${(f)"$(jq -r 'to_entries[] | select(.key != "chainId" and .key != "EnsGateAlias") | .key' $WC_JSON)"}; do
  a=$(addr $WC_JSON .$key)
  code=$(cast code $a -r $WC_RPC 2>/dev/null)
  if [[ ${#code} -le 2 ]]; then fail "1874 $key $a: no code"; continue; fi
  sc=$(curl -fsS "$BLOCKSCOUT/smart-contracts/$a" 2>/dev/null)
  v=$(print -r -- $sc | jq -r '.is_verified // false')
  name=$(print -r -- $sc | jq -r '.name // ""')
  if [[ $v == true ]]; then
    pass "1874 $key $a: code $(( (${#code} - 2) / 2 )) bytes, Blockscout verified ($name)"
  else
    impl=$(print -r -- $sc | jq -r '.implementations[0].address_hash // empty')
    if [[ -n $impl && $(curl -fsS "$BLOCKSCOUT/smart-contracts/$impl" | jq -r '.is_verified // false') == true ]]; then
      pass "1874 $key $a: proxy (not ours), implementation $impl Blockscout verified"
    else
      fail "1874 $key $a: not verified on Blockscout"
    fi
  fi
done
for key in ${(f)"$(jq -r 'paths(scalars) | map(tostring) | join(".")' $L1_JSON | grep -v -e '^chainId$' -e '^PaymentModuleL2$')"}; do
  a=$(addr $L1_JSON .$key)
  code=$(cast code $a -r $SEPOLIA_RPC 2>/dev/null)
  [[ ${#code} -gt 2 ]] && pass "11155111 $key $a: code $(( (${#code} - 2) / 2 )) bytes" || fail "11155111 $key $a: no code"
done
m=$(curl -fsS "$SOURCIFY/contract/11155111/$GATE" | jq -r '.match // "none"')
expect "Sourcify match for EnsGate $GATE" $m exact_match
expect "11155111 PaymentModuleL2 == 1874 PaymentModule" $(addr $L1_JSON .PaymentModuleL2) $PM

# ---------------------------------------------------------------------------
section "2. Wiring"
GATE_ALIAS=$(alias_l1_to_l2 $GATE)
expect "PaymentModule.ensGateAlias() == alias(EnsGate $GATE)" $(call $PM "ensGateAlias()(address)" -r $WC_RPC) $GATE_ALIAS
expect "deployments EnsGateAlias == alias(EnsGate)" $(addr $WC_JSON .EnsGateAlias) $GATE_ALIAS
expect "EnsGate.paymentModule() == PaymentModule" $(call $GATE "paymentModule()(address)" -r $SEPOLIA_RPC) $PM
expect "EnsGate.portal() == OptimismPortal" $(call $GATE "portal()(address)" -r $SEPOLIA_RPC) $PORTAL
expect "EnsGate.taz0rRegistry() == taz0r sub-registry" $(call $GATE "taz0rRegistry()(address)" -r $SEPOLIA_RPC) $TAZ0R_REGISTRY
expect "PaymentModule.roleCache() == RoleCache" $(call $PM "roleCache()(address)" -r $WC_RPC) $RC
expect "PaymentModule.revocationList() == RevocationList" $(call $PM "revocationList()(address)" -r $WC_RPC) $RL
expect "PaymentModule.usdt() == USDT" $(call $PM "usdt()(address)" -r $WC_RPC) $USDT
expect "MandateModule.paymentModule() == PaymentModule" $(call $MM "paymentModule()(address)" -r $WC_RPC) $PM

# ---------------------------------------------------------------------------
section "3. Live transactions"
# invoice_paid <label> <tx> <viaL1 expected> [amount expected]
invoice_paid() {
  local r=$(receipt $WC_RPC $2)
  [[ -z $r ]] && { fail "$1 $2: receipt not found"; return }
  expect "$1 status" $(print -r -- $r | jq -r .status) 0x1
  local l=$(log_of "$r" $PM $T_INVOICE_PAID)
  [[ -z $l ]] && { fail "$1: no InvoicePaid from PaymentModule"; return }
  local d=$(print -r -- $l | jq -r .data)
  local account=$(addr_of_word $(print -r -- $l | jq -r '.topics[1]'))
  local payee=$(addr_of_word $(word $d 0)) amount=$(dec $(word $d 1)) via=$(dec $(word $d 2))
  print -r -- "      InvoicePaid account=$account nonce=$(dec $(print -r -- $l | jq -r '.topics[2]')) payee=$payee amount=$amount viaL1=$via"
  expect "$1 InvoicePaid.viaL1" $via $3
  [[ -n ${4:-} ]] && expect "$1 InvoicePaid.amount" $amount $4
  PAID_ACCOUNT=$account PAID_PAYEE=$payee
}

invoice_paid "payment" 0xbceeaa443a3e17a19037a677a459a88dcd11a7e17b01ebd431118c997ce84f21 0 1200000

L1TX=0x2e387ff547f1100cc6ef5baf780acaf19a220b0b0ce7d140b7dc06e8ec561019
L2TX=0xa00dbd6923b79335f4ee60733adaa0f68652a47915141ddba0e6719b48eea30e
r1=$(receipt $SEPOLIA_RPC $L1TX)
if [[ -z $r1 ]]; then fail "fallback L1 $L1TX: receipt not found"; else
  expect "fallback L1 status" $(print -r -- $r1 | jq -r .status) 0x1
  expect "fallback L1 to == EnsGate" $(print -r -- $r1 | jq -r .to) $GATE
  dep=$(log_of "$r1" $PORTAL $T_DEPOSITED)
  if [[ -z $dep ]]; then fail "fallback L1: no TransactionDeposited from the portal"; else
    expect "deposit from == alias(EnsGate)" $(addr_of_word $(print -r -- $dep | jq -r '.topics[1]')) $GATE_ALIAS
    expect "deposit to == PaymentModule" $(addr_of_word $(print -r -- $dep | jq -r '.topics[2]')) $PM
    # OP Stack user-deposit source hash: keccak256(bytes32(0) ++ keccak256(l1BlockHash ++ uint256(logIndex)))
    id=$(cast keccak $(cast concat-hex $(print -r -- $r1 | jq -r .blockHash) $(cast to-uint256 $(print -r -- $dep | jq -r .logIndex))))
    SOURCE_HASH=$(cast keccak $(cast concat-hex 0x0000000000000000000000000000000000000000000000000000000000000000 $id))
  fi
fi
tx2=$(cast tx $L2TX --json -r $WC_RPC 2>/dev/null)
if [[ -z $tx2 ]]; then fail "fallback L2 $L2TX: tx not found"; else
  expect "fallback L2 type (deposit)" $(print -r -- $tx2 | jq -r .type) 0x7e
  expect "fallback L2 from == alias(EnsGate)" $(print -r -- $tx2 | jq -r .from) $GATE_ALIAS
  expect "fallback L2 sourceHash == hash of the L1 deposit log" $(print -r -- $tx2 | jq -r .sourceHash) ${SOURCE_HASH:-missing}
  invoice_paid "fallback L2" $L2TX 1
  if [[ -n $r1 ]]; then
    t1=$(dec $(cast block $(print -r -- $r1 | jq -r .blockNumber) --field timestamp -r $SEPOLIA_RPC))
    t2=$(dec $(cast block $(cast receipt $L2TX blockNumber -r $WC_RPC) --field timestamp -r $WC_RPC))
    print -r -- "      latency: Sepolia block time $t1 -> Whitechain block time $t2 = $((t2 - t1)) s"
    (( t2 >= t1 )) && pass "fallback latency $((t2 - t1)) s (L1 inclusion to L2 execution)" || fail "fallback L2 executed before L1"
  fi
fi

roles_synced() {
  local r=$(receipt $WC_RPC $2)
  [[ -z $r ]] && { fail "$1 $2: receipt not found"; return }
  expect "$1 status" $(print -r -- $r | jq -r .status) 0x1
  local l=$(log_of "$r" $RC $T_ROLES_SYNCED)
  [[ -z $l ]] && { fail "$1: no RolesSynced from RoleCache"; return }
  local d=$(print -r -- $l | jq -r .data)
  pass "$1 RolesSynced registry=$(addr_of_word $(print -r -- $l | jq -r '.topics[1]')) account=$(addr_of_word $(print -r -- $l | jq -r '.topics[2]')) roles=$(cast to-hex $(dec $(word $d 0))) l1Block=$(dec $(word $d 1))"
}
roles_synced "role sync" 0xd67061dda74f7918c4409163d669fba2034f2ab6d6be9b401a3cef9b87d9a440
roles_synced "watcher sync" 0xddfb4170e6ab70e9c884ba394d5a12e6d3e7885ab9ad35716e6dfdd7d4747ef5

ACME_ACCOUNT=0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6
RAVI=0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb
r=$(receipt $WC_RPC 0x027e1cfd06b86adaadab600b98b9444c98178c56ff038ef09daacb3df6ecd6ef)
if [[ -z $r ]]; then fail "revoke: receipt not found"; else
  expect "revoke status" $(print -r -- $r | jq -r .status) 0x1
  l=$(log_of "$r" $RL $T_REVOKED)
  if [[ -z $l ]]; then fail "revoke: no ApproverRevoked"; else
    expect "ApproverRevoked.account" $(addr_of_word $(print -r -- $l | jq -r '.topics[1]')) $ACME_ACCOUNT
    expect "ApproverRevoked.target" $(addr_of_word $(print -r -- $l | jq -r '.topics[2]')) $RAVI
  fi
fi
expect "RevocationList.isRevoked(acme, Ravi)" $(call $RL "isRevoked(address,address)(bool)" $ACME_ACCOUNT $RAVI -r $WC_RPC) true

r=$(receipt $WC_RPC 0x57117de515ca27dd80638e20c457949e6fa7c1d5d56d6ac8970c784c54d12a1a)
if [[ -z $r ]]; then fail "mandate create: receipt not found"; else
  expect "mandate create status" $(print -r -- $r | jq -r .status) 0x1
  l=$(log_of "$r" $MM $T_MANDATE_CREATED)
  if [[ -z $l ]]; then fail "mandate create: no MandateCreated"; else
    MANDATE_ID=$(print -r -- $l | jq -r '.topics[1]')
    M_ACCOUNT=$(addr_of_word $(print -r -- $l | jq -r '.topics[2]'))
    M_PAYEE=$(addr_of_word $(print -r -- $l | jq -r '.topics[3]'))
    d=$(print -r -- $l | jq -r .data)
    pass "MandateCreated id=$MANDATE_ID account=$M_ACCOUNT payee=$M_PAYEE cap=$(dec $(word $d 0)) period=$(dec $(word $d 1))s"
  fi
fi
r=$(receipt $WC_RPC 0x593e6ac94971ca40c6ee3b8c67f0064a43044ba6bfeabe88181906d4c46210b2)
if [[ -z $r ]]; then fail "mandate pull: receipt not found"; else
  expect "mandate pull status" $(print -r -- $r | jq -r .status) 0x1
  l=$(log_of "$r" $MM $T_MANDATE_PULLED)
  [[ -n $l ]] && expect "MandatePulled.mandateId == created id" $(print -r -- $l | jq -r '.topics[1]') ${MANDATE_ID:-missing} \
    || fail "mandate pull: no MandatePulled"
  t=$(log_of "$r" $USDT $T_TRANSFER)
  if [[ -n $t ]]; then
    expect "pull USDT from == mandate account" $(addr_of_word $(print -r -- $t | jq -r '.topics[1]')) ${M_ACCOUNT:-missing}
    expect "pull USDT to == mandate payee" $(addr_of_word $(print -r -- $t | jq -r '.topics[2]')) ${M_PAYEE:-missing}
    print -r -- "      pulled $(dec $(print -r -- $t | jq -r .data)) USDT base units"
  else fail "mandate pull: no USDT Transfer"; fi
fi

invoice_paid "credit note" 0x4be6a82a6f5a8aa7df415cecda37f693d2e4b09659474765fac407d9da1b4c38 0
if [[ -n ${PAID_PAYEE:-} ]]; then
  pc=$(cast code $PAID_PAYEE -r $WC_RPC 2>/dev/null)
  [[ ${#pc} -gt 2 ]] && pass "credit note payee $PAID_PAYEE is a contract account (paid back by $PAID_ACCOUNT)" \
    || fail "credit note payee $PAID_PAYEE is not a contract account"
fi

# ---------------------------------------------------------------------------
section "4. ENS roles on Whitechain match Ethereum storage"
PRIYA=0x00aBed5bDddf794c415eE746d3E4De5332cC5450
out=(${(f)"$(cast call $RC "rolesOf(address,address)(uint256,uint64)" $ACME_REGISTRY $PRIYA -r $WC_RPC 2>/dev/null)"})
cached_roles=${out[1]%% *} cached_block=${out[2]%% *}
print -r -- "      RoleCache.rolesOf(acme, Priya) = roles $(cast to-hex $cached_roles) at L1 block $cached_block"
slot=$(cast keccak $(cast abi-encode "f(address,bytes32)" $PRIYA $(cast keccak $(cast abi-encode "f(uint256,uint256)" 0 2))))
expect "RoleCache.rolesSlot(Priya) == keccak(abi.encode(account, keccak(abi.encode(0, 2))))" \
  $(cast to-hex $(call $RC "rolesSlot(address)(uint256)" $PRIYA -r $WC_RPC)) $slot
onchain=$(cast storage $ACME_REGISTRY $slot -r $SEPOLIA_RPC -b $cached_block 2>/dev/null)
expect "Sepolia storage of acme roles[0][Priya] at block $cached_block" $(cast to-hex $(dec ${onchain:-0x0})) $(cast to-hex $cached_roles)

# ---------------------------------------------------------------------------
section "5. taz0r.eth on Ethereum Sepolia"
expect "ETHRegistry.getSubregistry(\"taz0r\")" $(call $ETH_REGISTRY "getSubregistry(string)(address)" taz0r -r $SEPOLIA_RPC) $TAZ0R_REGISTRY
expect "ETHRegistry.findOwner(\"taz0r\")" $(call $ETH_REGISTRY "findOwner(string)(address)" taz0r -r $SEPOLIA_RPC) $TAZ0R_OWNER
expect "taz0r.eth subregistry \"acme\"" $(call $TAZ0R_REGISTRY "getSubregistry(string)(address)" acme -r $SEPOLIA_RPC) $ACME_REGISTRY
expect "taz0r.eth subregistry \"bluejay\"" $(call $TAZ0R_REGISTRY "getSubregistry(string)(address)" bluejay -r $SEPOLIA_RPC) $BLUEJAY_REGISTRY

print
print -r -- "$passes passed, $fails failed"
(( fails == 0 ))
