#!/usr/bin/env zsh
# Puts the sandbox (Autopilot) settings into the hosted relayer's Vercel project, production environment:
#   - addresses and ids from scripts/sandbox/setup.json (.relayerConfig);
#   - the demo keys SANDBOX_{OPERATOR,ADMIN,RAVI,SUPPLIER,FINANCIER}_KEY from the environment / $ENV_FILE;
#   - WATCH_REGISTRIES = what the live relayer watches now (its /health) + the sandbox registry.
# Each variable is replaced (vercel env rm, then vercel env add with the value on stdin); values are never printed.
# Runs in apps/relayer/dist/tazor-relayer (the linked Vercel project). Redeploy the relayer afterwards.
#
# Usage:   zsh scripts/sandbox-vercel-env.sh
#          DRY_RUN=1 zsh scripts/sandbox-vercel-env.sh     # prints the variable names it would set (no values, no vercel calls)
# Overrides: ENV_FILE (default tazor/.env.local), SETUP_JSON, RELAYER_URL, VERCEL_DIR, VERCEL_ENVIRONMENT (production).
set -u
setopt pipefail

ROOT=${0:A:h:h}
ENV_FILE=${ENV_FILE:-$ROOT/.env.local}
if [[ -f $ENV_FILE ]]; then set -a; source $ENV_FILE; set +a; fi
DRY_RUN=${DRY_RUN:-0}
SETUP_JSON=${SETUP_JSON:-$ROOT/scripts/sandbox/setup.json}
RELAYER_URL=${RELAYER_URL:-https://tazor-relayer.vercel.app}
RELAYER_URL=${RELAYER_URL%/}
VERCEL_DIR=${VERCEL_DIR:-$ROOT/apps/relayer/dist/tazor-relayer}
TARGET=${VERCEL_ENVIRONMENT:-production}
for bin in jq curl; do command -v $bin >/dev/null || { print -u2 "missing dependency: $bin"; exit 2; }; done
[[ $DRY_RUN == 1 ]] || command -v vercel >/dev/null || { print -u2 "missing dependency: vercel"; exit 2; }

die() { print -u2 -r -- "FAIL  $*"; exit 1 }
is_addr() { [[ $1 =~ '^0x[0-9a-fA-F]{40}$' ]] }

# ---- what to set

[[ -f $SETUP_JSON ]] || { [[ $DRY_RUN == 1 ]] || die "$SETUP_JSON not found (run scripts/setup-sandbox.sh first)"; }
cfg() { [[ -f $SETUP_JSON ]] && jq -r ".relayerConfig.$1 // empty" $SETUP_JSON }
[[ -f $SETUP_JSON && $(jq -r '.dryRun // false' $SETUP_JSON) == true ]] && die "$SETUP_JSON is from a dry run"

typeset -a NAMES
typeset -A VALUES
add_value() {   # <NAME> <value> <kind: address|id|key|list>
  local name=$1 value=$2 kind=$3
  if [[ -z $value ]]; then
    [[ $DRY_RUN == 1 ]] && { NAMES+=($name); VALUES[$name]=""; return 0; }
    die "$name is empty"
  fi
  case $kind in
    address) is_addr $value || die "$name is not an address" ;;
    key) [[ ${value#0x} =~ '^[0-9a-fA-F]{64}$' ]] || die "$name is not a 32-byte hex key" ;;
    id) [[ $value =~ '^(0x[0-9a-fA-F]{64}|[0-9]+)$' ]] || die "$name is not a bytes32 or decimal id" ;;
  esac
  NAMES+=($name); VALUES[$name]=$value
}
for k in SANDBOX_ACCOUNT SANDBOX_REGISTRY SANDBOX_SUPPLIER MIRROR_OPERATOR SANDBOX_OPERATOR SANDBOX_ADMIN_ACCOUNT \
         SANDBOX_RAVI_ACCOUNT SANDBOX_SUPPLIER_SIGNER_ACCOUNT SANDBOX_FINANCIER SANDBOX_FINANCIER_ACCOUNT; do
  add_value $k "$(cfg $k)" address
done
add_value SANDBOX_MANDATE_ID "$(cfg SANDBOX_MANDATE_ID)" id
add_value SANDBOX_CLAIM_ID "$(cfg SANDBOX_CLAIM_ID)" id
for k in SANDBOX_OPERATOR_KEY SANDBOX_ADMIN_KEY SANDBOX_RAVI_KEY SANDBOX_SUPPLIER_KEY SANDBOX_FINANCIER_KEY; do
  add_value $k "${(P)k:-}" key
done

# WATCH_REGISTRIES: what the live relayer watches + the sandbox registry (deduplicated, checksummed as given)
health=$(curl -sS -m 30 $RELAYER_URL/health) || die "relayer unreachable at $RELAYER_URL (needed to read the current WATCH_REGISTRIES)"
current=(${(f)"$(print -r -- $health | jq -r '.watchRegistries[]?')"})
(( ${#current} )) || print -r -- "   note: the live relayer reports no watched registries; WATCH_REGISTRIES will be the sandbox registry only"
sandbox_reg=$(cfg SANDBOX_REGISTRY)
typeset -a regs seen
for r in $current $sandbox_reg; do
  [[ -n $r ]] || continue
  is_addr $r || die "bad registry in the list: $r"
  (( ${seen[(Ie)${r:l}]} )) || { seen+=(${r:l}); regs+=($r); }
done
add_value WATCH_REGISTRIES "${(j:,:)regs}" list

# ---- set them

print -r -- "Vercel env ($TARGET) in ${VERCEL_DIR#$ROOT/}$([[ $DRY_RUN == 1 ]] && print '  DRY RUN: names only, nothing is changed')"
print -r -- "   WATCH_REGISTRIES: ${#current} watched now$([[ -n $sandbox_reg ]] && print " + sandbox registry") → ${#regs} registr$([[ ${#regs} == 1 ]] && print y || print ies)"
if [[ $DRY_RUN == 1 ]]; then
  for n in $NAMES; do print -r -- "   would set $n$([[ -z ${VALUES[$n]} ]] && print '  (missing: setup not finished yet)')"; done
  print -r -- "RESULT: DRY RUN (${#NAMES} variables)"
  exit 0
fi
[[ -d $VERCEL_DIR/.vercel ]] || die "$VERCEL_DIR is not linked to a Vercel project (no .vercel directory)"
cd $VERCEL_DIR || die "cannot cd to $VERCEL_DIR"
typeset -a done_names
for n in $NAMES; do
  vercel env rm $n $TARGET -y >/dev/null 2>&1   # absent is fine
  if print -rn -- "${VALUES[$n]}" | vercel env add $n $TARGET >/dev/null 2>&1; then
    done_names+=($n); print -r -- "   set $n"
  else
    die "vercel env add $n failed (already set: ${(j:, :)done_names}); re-run to continue"
  fi
done
print -r -- "RESULT: PASS (${#done_names} variables set in $TARGET). Redeploy the relayer: cd ${VERCEL_DIR#$ROOT/} && vercel deploy --prod --yes"
