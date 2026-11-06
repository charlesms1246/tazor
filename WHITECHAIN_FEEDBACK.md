# Whitechain feedback

Notes from building Tazor on Whitechain Sepolia at ETHGlobal Mumbai, November 2026.

## What worked

- **P-256 precompile (`0x100`, RIP-7212):** it worked first time with real browser passkey signatures, which let me verify Face ID approvals on-chain with no per-signer contracts.
- **Reading Ethereum from Whitechain:** the `L1Block` predeploy and the EIP-2935 history contract gave me a clean way to verify Ethereum (ENSv2) storage proofs on Whitechain.
- **Deposits from Ethereum:** contract deposits through the OptimismPortal reached Whitechain in **64–69 s** (measured), delivered from the aliased sender. That was faster than my own 1.5–2 min estimate (the docs give no figure), and it's exactly what my censorship-resistant fallback needs.
- **Blockscout:** verification worked well for every contract I deployed, and the Blockscout API made my verification checks scriptable.
- **The Blockscout v2 API is CORS-open:** my static app reads account activity, invoice/mandate history and the ENS directory straight from the browser, with no backend. That made "real on-chain data on any device" easy.
- **Real WB Soul data is readable from mainnet:** `soulOf` on `0x…2000` plus `soulAttributeValue` on `0x…2002` over the public RPC (CORS-open), so the app shows a person's real mainnet verification next to the testnet mirror.
- **Speed in practice:** a passkey payment through Tazor's hosted relayer confirms in about 2.5–3 s, and a payment run pays two invoices in one transaction.

## Where I got stuck

- **`eth_getProof` at `"latest"`** fails on the testnet RPC with "no state found" (your team reproduced it, thanks).
  - `safe` and `finalized` work, but on testnet they trail the head by about 1,600 blocks (~27 min).
  - Proofs verified on-chain with `blockhash` need a block from the last 256, so I use an explicit hex `latest − 5`.
- **Decimal block numbers are rejected:** the RPC returns `Invalid params: hex string without 0x prefix`. Named tags work.
  - What failed for me: a library (Unruggable Gateways' `staticCall` via ethers) passed a block number through as a decimal.
  - Passing `0x`-hex quantities fixed it.
- **Flashblocks / `eth_sendRawTransactionSync`** aren't whitelisted on the public RPC, so I poll for receipts instead.
- **RIP-7728 (L1SLOAD)** isn't available, so reading Ethereum state needs a full storage proof and costs about 0.96M gas per role sync.
- **No Safe passkey factory, Safe7579 or ERC-7484 registry** on Whitechain. I built my accounts on OpenZeppelin's ERC-7579 and ERC-7913 contracts instead.
- **WB Soul isn't deployed on testnet,** so I test against a mirror contract with the same interface, plus a mainnet-fork test for the real registry. To let hackathon guests try the app, I had to put the mirror behind a small operator contract so a server could verify new demo users. An official testnet WB Soul (or a faucet-style "test Soul") would remove that.
- **Proofs need the L1 block the prover actually uses:** a role sync proven against an older Ethereum block than the ENS change silently stores the old value. I now compare against the proof's own L1 block before sending. A short note in the docs on `L1Block` lag versus proof freshness would help others.
- **Wallet security scanners:** MetaMask (Blockaid) flagged the new hosted domain as "malicious" when it asked the wallet to send the Ethereum fallback transaction (EnsGate → OptimismPortal deposit). I now route that step through a public explorer's write-contract page. A Whitechain-endorsed allowlist path, or guidance for dapps that make portal deposits, would help builders.

## What the docs were missing

- **Where WB Soul's verification status lives:** "IsVerified" is not on the soul registry. It is an attribute in `SoulAttributeRegistry` (`0x…2002`), `soulAttributeValue(soulId, 0xd88f…1e41) == bytes20(uint160(1))`. I found this only by reading verified source on Blockscout.
- **A list of the RPC's quirks:** the supported methods and block-tag formats, and the `latest` proof behaviour.
- **Precompiles and predeploys:** which ones are available on testnet and which are on mainnet (P-256, EIP-2935, L1SLOAD).
- **Typical deposit latency and portal settings:** for example, that the portal is in custom-gas-token mode, so `msg.value` must be 0.
- **Which explorer verifies where:** Whitechain's explorers are Blockscout; for the Sepolia side I found Blockscout verification more reliable to script than Etherscan (which needs an API key).
- **A tested public Sepolia RPC list:** free Sepolia RPCs rate-limit (Tenderly returned "Request exceeds defined limit"), and some refuse `eth_getProof` (publicnode). Tazor's relayer now uses one for sending and another for proofs.

- **USDT's EIP-712 domain isn't discoverable:** the track USDT has no `version()` or `eip712Domain()` (both revert), so to sign EIP-3009 or permit you have to guess the domain. I matched `DOMAIN_SEPARATOR()` by brute force: `{ name: "Tether USD", version: "1", chainId: 1874 }`. One line in the docs, next to the USDT address, would save every Scale team an hour. It's worth noting that the 3009 and permit `bytes`-signature overloads exist and accept ERC-1271 signatures.
- **What "finalized" means on testnet:** the lag moves around a lot. At 23:5x IST `safe` and `finalized` were the same block, about 1,600 blocks (~27 min) behind `latest`. At 00:3x IST `safe` was about 900 blocks behind (~15 min) and `finalized` about 2,600 (~44 min). A short table of the typical soft, safe and finalized timings, and what a merchant should wait for, would help everyone building receipts.

## Answers I got from DevRel during the event (and what I did)

- **Simulated WB Soul on testnet is fine if clearly labelled.** It's labelled in the app and the README, and the real registry is exercised on a Whitechain mainnet fork.
- **Binding a smart-account address to a soul is still open.** My fallback is EIP-7702: a person's already-bound wallet delegates to a small approver contract and keeps its address. It's live on testnet.
- **No deposit filter, and the Guardian can pause withdrawals or blacklist dispute games, not deposits.** That fits my claim that payments get in. I call `depositTransaction` with `msg.value = 0` (custom gas token mode).
- **No RIP-7728 plans.** I already use `L1Block` plus storage proofs, as suggested.
- **Whitechain stays on Prague, and mainnet has a subset of Osaka (16,777,216 gas per tx).** I compile for Prague, and my largest Whitechain tx was 5.28M gas.
- **No hosted bundler.** I run my own relayer and bundler.

