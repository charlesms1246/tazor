#!/usr/bin/env zsh
# Builds scripts/demo-v2/last-run.json from a saved demo-v2.sh output (its "== Summary" table), for runs made
# before demo-v2.sh recorded transactions itself. Usage: record-from-log.sh <demo-output.log> [company] [salt]
set -u
setopt pipefail
ROOT=${0:A:h:h:h}
LOG=${1:?usage: record-from-log.sh <demo-output.log> [company] [salt]}
OUT=${RUN_JSON:-$ROOT/scripts/demo-v2/last-run.json}
json=$(jq -n --arg company "${2:-unknown}" --arg salt "${3:-unknown}" '{startedAt: "from log", company: $company, salt: $salt, txs: []}')
in_summary=0
while IFS= read -r line; do
  [[ $line == "== Summary"* ]] && { in_summary=1; continue }
  (( in_summary )) || continue
  [[ $line =~ '^([0-9]+) +\| (.*) (0x[0-9a-fA-F]{64}) +\|' ]] || continue
  step=$match[1] label=${match[2]%% #} hash=$match[3] chain=whitechain
  [[ $label == *"(Sepolia)"* ]] && chain=sepolia
  json=$(print -r -- $json | jq --argjson step $step --arg label "$label" --arg chain $chain --arg hash $hash \
    '.txs += [{step: $step, label: $label, chain: $chain, hash: $hash}]')
done < $LOG
print -r -- $json > $OUT
print -r -- "wrote $OUT with $(print -r -- $json | jq '.txs | length') transactions"
