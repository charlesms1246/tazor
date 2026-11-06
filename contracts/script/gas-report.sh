#!/usr/bin/env bash
# Produces ../proofs/gas/report.txt (forge --gas-report plus raw isolated traces) and
# ../proofs/gas/summary.txt (per-action table: full-tx gas incl. intrinsic, and execution-only gas).
# Run from contracts/. Needs network access for the Whitechain Sepolia and Ethereum Sepolia forks.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=../proofs/gas
mkdir -p "$OUT"
TMP=$(mktemp -d)

echo "== forge test --gas-report (all suites) ==" > "$OUT/report.txt"
forge test --gas-report >> "$OUT/report.txt" 2>&1

forge test --match-path 'test/gas/*' --isolate -vvvv > "$TMP/prague.txt" 2>&1
forge test --match-path 'test/gas/GasReport.local.t.sol' --evm-version osaka --isolate -vvvv > "$TMP/osaka.txt" 2>&1
{
  echo
  echo "== isolated traces, default EVM (prague) =="
  cat "$TMP/prague.txt"
  echo
  echo "== isolated traces, local suite with --evm-version osaka =="
  cat "$TMP/osaka.txt"
} >> "$OUT/report.txt"

python3 -I - "$TMP/prague.txt" "$TMP/osaka.txt" > "$OUT/summary.txt" <<'PY'
import re, sys

FRAME = re.compile(r'^    [├└]─ \[(\d+)\] (\S+?)::')
GAS = re.compile(r'console::log\("GAS\|([^|]*)\|(\d+)\|(\d+)"\)')

def parse(path):
    rows, last = [], None
    for line in open(path, encoding='utf-8'):
        g = GAS.search(line)
        if g and last is not None:
            rows.append((g.group(1), last, int(g.group(2)), int(g.group(3))))
            last = None
            continue
        m = FRAME.match(line)
        if m and m.group(2) not in ('console', 'VM'):
            last = int(m.group(1))
        if re.match(r'^\s*\[(PASS|FAIL)', line):
            last = None
    return rows

rows = parse(sys.argv[1]) + [r for r in parse(sys.argv[2]) if 'passkey check' in r[0]]
seen, out = set(), []
for label, full, z, nz in rows:
    if label in seen:
        continue
    seen.add(label)
    intrinsic = 21000 + 4 * z + 16 * nz
    floor = 21000 + 10 * z + 40 * nz
    execution = full - intrinsic
    floored = full <= floor
    note = 'EIP-7623 calldata floor charged; execution is an upper bound' if floored else ''
    out.append((label, full, ('<=' if floored else '') + f"{execution:,}", z + nz, note))
    if label.startswith('payRun(10)'):
        out.append(('  payRun(10) per invoice', full // 10, f"{execution // 10:,}", (z + nz) // 10, ''))

w = max(len(r[0]) for r in out)
print('Tazor gas summary (forge --isolate: each action is its own transaction, cold state)')
print('Full tx = trace top frame, includes the 21,000 base + calldata intrinsic cost.')
print('Execution = full tx - (21000 + 4*zero_bytes + 16*nonzero_bytes).')
print('Whitechain actions: Whitechain Sepolia fork, block 12,343,263, real USDT + WBSoulMirror.')
print()
print(f"{'Action'.ljust(w)} | {'Full tx':>9} | {'Execution':>9} | {'Calldata B':>10} | Notes")
print('-' * (w + 50))
for label, full, execution, cd, note in out:
    print(f"{label.ljust(w)} | {full:>9,} | {execution:>9} | {cd:>10,} | {note}")
print()
print('Notes:')
print('- Passkey: forge prague has no P-256 precompile (OZ Solidity fallback). The osaka row uses EIP-7951')
print('  P256VERIFY at 0x100 (6,900 gas). Whitechain live uses RIP-7212 at 0x100 (~3,450 gas), so expect')
print('  roughly 3.4k less than the osaka row on chain.')
print('- RoleCache.syncRoles here uses the real proof fixture with a MOCK verifier: it measures calldata,')
print('  decoding and storage only. The live tx with the real Unruggable verifier used 963,930 gas.')
print('- EnsGate.forward runs on an Ethereum Sepolia fork under prague rules. Sepolia runs Glamsterdam;')
print('  live costs can be much higher (the EnsGate CREATE3 deploy cost ~4.4M live vs ~660k simulated).')
print('- payFromL1 is the L2 leg only (executed by the deposit); the L1 leg is EnsGate.forward.')
print('- EnsGate.forward includes OptimismPortal resource metering, which burns L1 gas to buy the')
print('  L2 gas limit (400,000), so most of its cost scales with L2_GAS_LIMIT, not with EnsGate code.')
print('- Approver signature checks inside payOne/payRun are ECDSA-backup ApproverAccounts; a passkey')
print('  approver adds roughly the passkey-check execution delta per approver.')
PY

rm -rf "$TMP"
cat "$OUT/summary.txt"
