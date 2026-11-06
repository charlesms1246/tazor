#!/usr/bin/env zsh
# Dry run of scripts/demo-v2.sh on anvil forks of Whitechain Sepolia and Ethereum Sepolia, with throwaway
# keys standing in for the deployer, Priya, CFO and Meera. Uses impersonation to set up their souls, role
# cache entries, ENS role, Meera's EIP-7702 delegation and USDT. Touches nothing live.
set -u
setopt pipefail

ROOT=${0:A:h:h:h}
WC_UP=${WC_UP:-https://rpc.testnet.whitechain.io}
L1_UP=${L1_UP:-https://sepolia.gateway.tenderly.co}
WC=http://127.0.0.1:8645
L1=http://127.0.0.1:8646
OWNER=0xce4389ACb79463062c362fACB8CB04513fA3D8D8      # mirror owner, USDT holder, acme ENS admin
MIRROR=0x9822650A99bD33F29E383345F570dAE1e4E00928
IS_VERIFIED=0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41
FACTORY=0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e
RC=0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe
USDT=0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7
ACME_REGISTRY=0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1
APPROVER7702=0xE504B6FB1BE655164a5EF14CCa5822ED7d3305ef

# anvil's well-known dev keys (#0..#2) and a fresh, unfunded key for Meera
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
PRIYA_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
CFO_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
MEERA_KEY=$(cast keccak "tazor demo-v2 dry-run meera")
DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
PRIYA_EOA=$(cast wallet address --private-key $PRIYA_KEY)
CFO_EOA=$(cast wallet address --private-key $CFO_KEY)
MEERA=$(cast wallet address --private-key $MEERA_KEY)

# The harness swaps contracts/broadcast/CreateCompany.s.sol/1874 (same chain id as the fork); never run it
# while a live demo is writing there.
if pgrep -f "scripts/demo-v2.sh" >/dev/null; then
  print -u2 "a demo-v2.sh run is in progress; run the dry run after it finishes"; exit 2
fi

BACKUP=$(mktemp -d)
BROADCAST=$ROOT/contracts/broadcast/CreateCompany.s.sol/1874
[[ -d $BROADCAST ]] && cp -R $BROADCAST $BACKUP/1874
cleanup() {
  kill ${WC_PID:-} ${L1_PID:-} 2>/dev/null
  rm -rf $BROADCAST
  [[ -d $BACKUP/1874 ]] && cp -R $BACKUP/1874 $BROADCAST
  rm -rf $BACKUP
}
trap cleanup EXIT INT TERM

anvil --fork-url $WC_UP --port 8645 --hardfork prague --silent & WC_PID=$!
anvil --fork-url $L1_UP --port 8646 --hardfork prague --silent & L1_PID=$!
for u in $WC $L1; do for i in {1..60}; do cast chain-id -r $u >/dev/null 2>&1 && break; sleep 1; done; done
print -r -- "forks up: Whitechain $(cast chain-id -r $WC) block $(cast block-number -r $WC), Sepolia $(cast chain-id -r $L1) block $(cast block-number -r $L1)"

as_owner() { local rpc=$1; shift; cast send "$@" --from $OWNER --unlocked -r $rpc >/dev/null || { print -u2 "setup failed: $*"; exit 1; } }
cast rpc anvil_impersonateAccount $OWNER -r $WC >/dev/null
cast rpc anvil_impersonateAccount $OWNER -r $L1 >/dev/null
cast rpc anvil_setBalance $OWNER 0x56BC75E2D63100000 -r $WC >/dev/null

# approver accounts with ECDSA backups
mk_approver() {
  cast send $FACTORY "createAccount(bytes[])" "[$1]" --private-key $DEPLOYER_KEY -r $WC >/dev/null
  cast call $FACTORY "predictAddress(bytes[])(address)" "[$1]" -r $WC
}
PRIYA=$(mk_approver $PRIYA_EOA)
CFO=$(mk_approver $CFO_EOA)

# Meera: EIP-7702 delegation to Approver7702, sponsored by the deployer (Meera holds no WBT)
auth=$(cast wallet sign-auth $APPROVER7702 --private-key $MEERA_KEY -r $WC)
cast send $MEERA --auth $auth --private-key $DEPLOYER_KEY -r $WC >/dev/null

# souls (verified) for Priya, CFO, Meera and the financier
for who in $PRIYA $CFO $MEERA $DEPLOYER; do
  as_owner $WC $MIRROR "registerSoul(address)" $who
  as_owner $WC $MIRROR "setAttribute(uint256,address,bytes20)" $(cast call $MIRROR "soulOf(address)(uint256)" $who -r $WC | awk '{print $1}') $IS_VERIFIED 0x0000000000000000000000000000000000000001
done

# role cache: Priya APPROVER|ADMIN with a stale entry (exercises the fresh-proof branch), CFO APPROVER|AGENT fresh
known=$(cast call 0x4200000000000000000000000000000000000015 "number()(uint64)" -r $WC | awk '{print $1}')
set_roles() {
  local slot=$(cast keccak $(cast abi-encode "f(address,bytes32)" $1 $(cast keccak $(cast abi-encode "f(address,uint256)" $ACME_REGISTRY 0))))
  cast rpc anvil_setStorageAt $RC $slot $(cast to-uint256 $2) -r $WC >/dev/null
  local next=0x$(print "obase=16; ibase=16; ${(U)slot#0x} + 1" | BC_LINE_LENGTH=0 bc)
  cast rpc anvil_setStorageAt $RC $(cast to-uint256 $next) $(cast to-uint256 $3) -r $WC >/dev/null
}
set_roles $PRIYA 0x110000000000000000 $((known - 400))     # APPROVER | TAZOR_ADMIN
set_roles $CFO 0x1010000000000000000 $known                 # APPROVER | AGENT

# USDT for the deployer (funding + financier)
as_owner $WC $USDT "transfer(address,uint256)" $DEPLOYER 15000000

# Sepolia: Priya gets the ENS APPROVER role in acme, so EnsGate v2 forwards her approval
as_owner $L1 $ACME_REGISTRY "grantRootRoles(uint256,address)" $(cast to-dec 0x10000000000000000) $PRIYA

print -r -- "dry-run entities: deployer $DEPLOYER, Priya $PRIYA, CFO $CFO, Meera $MEERA (7702)"

DRY_RUN=1 ENV_FILE=/dev/null WC_RPC=$WC SEPOLIA_RPC=$L1 \
  DEPLOYER_KEY=$DEPLOYER_KEY PRIYA_KEY=$PRIYA_KEY CFO_KEY=$CFO_KEY MEERA_KEY=$MEERA_KEY \
  PRIYA_ACCOUNT=$PRIYA CFO_ACCOUNT=$CFO MEERA=$MEERA COMPANY_SALT="dry-run-$(date +%s)" \
  zsh $ROOT/scripts/demo-v2.sh
