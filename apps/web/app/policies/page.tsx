'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatUnits, getAddress, isAddress, type Address, type Hex } from 'viem';
import { signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import {
  MAX_GRANT_SECONDS, ROLE_AGENT, ROLE_APPROVER, decodeConfigV2, decodePayeeAddedAt, decodePendingExit, decodeTypedDigest,
  decodeWindowAvailable, encodeConfigV2Of, encodeExecuteExit, encodePayeeAddedAt, encodePendingExit, encodePolicyCall,
  encodeTypedDigest, encodeWindowAvailable, policyDigest, policyStructHash, type ConfigV2, type PolicyMessage,
} from '@/lib/policies.ts';
import { ethCall } from '@/lib/rpc.ts';
import { loadPasskey } from '@/lib/storage.ts';
import { sendOnWhitechain } from '@/lib/wallet-wc.ts';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { ApproversPanel } from './approvers.tsx';

const registryAbi = parseAbi(['function registryOf(address account) view returns (address)']);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
async function v1Registry(account: Address): Promise<Address | null> {
  if (!config.paymentModule) return null;
  try {
    const reg = decodeFunctionResult({ abi: registryAbi, functionName: 'registryOf', data: await ethCall(config.paymentModule, encodeFunctionData({ abi: registryAbi, functionName: 'registryOf', args: [account] })) });
    return reg === ZERO_ADDR ? null : reg;
  } catch {
    return null;
  }
}

const usdt = (v: bigint) => `${formatUnits(v, 6)} USDT`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const PAYEES_KEY = (account: Address) => `tazor.v2.payees.${account.toLowerCase()}`;

function loadKnownPayees(account: Address): Address[] {
  try { return JSON.parse(localStorage.getItem(PAYEES_KEY(account)) ?? '[]') as Address[]; } catch { return []; }
}
function rememberPayee(account: Address, payee: Address) {
  try {
    const list = loadKnownPayees(account).filter((p) => p.toLowerCase() !== payee.toLowerCase());
    localStorage.setItem(PAYEES_KEY(account), JSON.stringify([...list, payee]));
  } catch { /* storage unavailable */ }
}

type Prepared = { to: Address; data: Hex; digest?: Hex };

/** Shows calldata for any wallet, plus "Send with your wallet". */
function Calldata({ p, id }: { p: Prepared; id: string }) {
  const [hash, setHash] = useState<Hex | null>(null);
  const [err, setErr] = useState('');
  return (
    <div data-testid={`${id}-out`}>
      {p.digest && <p>Signed digest (matches the contract): <code data-testid={`${id}-digest`}>{p.digest}</code></p>}
      <p>To {p.to} on Whitechain Sepolia (anyone can send it):<br />
        <code data-testid={`${id}-calldata`} style={{ wordBreak: 'break-all' }}>{p.data}</code></p>
      <button onClick={() => navigator.clipboard?.writeText(JSON.stringify({ to: p.to, data: p.data })).catch(() => undefined)}>Copy calldata</button>{' '}
      <button onClick={() => sendOnWhitechain(p.to, p.data).then(setHash, (e) => setErr(msg(e)))}>Send with your wallet</button>
      {hash && <p>Sent: <a href={`${config.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{hash}</a></p>}
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </div>
  );
}

/** Builds a policy message, checks the contract digest against the local EIP-712 digest, signs with the passkey. */
async function signPolicy(pm: Address, m: PolicyMessage): Promise<Prepared> {
  const key = loadPasskey();
  if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
  const local = policyDigest(m, { chainId: config.chainId, verifyingContract: pm });
  const onchain = decodeTypedDigest(await ethCall(pm, encodeTypedDigest(policyStructHash(m))));
  if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error(`Refusing to sign: contract digest ${onchain} differs from ${local}.`);
  const sig = await signDigestWithPasskey(key.credentialId, local, key);
  return { to: pm, data: encodePolicyCall(m, key.approverAccount, sig), digest: local };
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [out, setOut] = useState<Prepared | null>(null);
  const run = (fn: () => Promise<Prepared>) => async () => {
    setBusy(true); setError(''); setOut(null);
    try { setOut(await fn()); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };
  return { busy, error, out, run };
}

export default function PoliciesPage() {
  const pm = configV2.paymentModule;
  const [input, setInput] = useState<string>(configV2.demoAccount);
  const [account, setAccount] = useState<Address | null>(null);
  const [cfg, setCfg] = useState<ConfigV2 | null>(null);
  const [win, setWin] = useState<readonly [bigint, bigint] | null>(null);
  const [exit, setExit] = useState<readonly [Address, bigint] | null>(null);
  const [payees, setPayees] = useState<{ payee: Address; addedAt: bigint }[]>([]);
  const [loadError, setLoadError] = useState('');
  const [v1, setV1] = useState<{ account: Address; registry: Address } | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!pm) return setLoadError('PaymentModuleV2 address is not configured.');
    if (!isAddress(input)) return setLoadError('Enter a company account address.');
    const a = getAddress(input);
    setLoadError('');
    setV1(null);
    try {
      const c = decodeConfigV2(await ethCall(pm, encodeConfigV2Of(a)));
      if (c.registry === ZERO_ADDR) {
        const reg = await v1Registry(a);
        if (!reg) throw new Error('This account has no PaymentModule configuration (not a v2 company, and not a v1 company either).');
        setAccount(null); setCfg(null);
        return setV1({ account: a, registry: reg });
      }
      setAccount(a);
      setCfg(c);
      setWin(decodeWindowAvailable(await ethCall(pm, encodeWindowAvailable(a))));
      setExit(decodePendingExit(await ethCall(pm, encodePendingExit(a))));
      const known = loadKnownPayees(a);
      setPayees(await Promise.all(known.map(async (payee) => ({ payee, addedAt: decodePayeeAddedAt(await ethCall(pm, encodePayeeAddedAt(a, payee))) }))));
    } catch (e) {
      setAccount(null); setCfg(null); setLoadError(msg(e));
    }
  }, [pm, input]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  const addPayee = useAction();
  const grant = useAction();
  const expiry = useAction();
  const exitAction = useAction();
  const [payee, setPayee] = useState('');
  const [grantee, setGrantee] = useState('');
  const [grantRoles, setGrantRoles] = useState({ approver: true, agent: false });
  const [expApprover, setExpApprover] = useState('');
  const [expUntil, setExpUntil] = useState('');
  const [exitIndex, setExitIndex] = useState(0);

  const deadline = () => nowS() + 3600n;
  void tick; // re-render every second for the countdowns
  const now = Number(nowS());

  return (
    <main>
      <h1>Company policies (v2)</h1>
      <p>
        <label>Company account <input data-testid="account" value={input} onChange={(e) => setInput(e.target.value)} size={44} /></label>{' '}
        <button data-testid="load" onClick={load}>Load</button>
      </p>
      {loadError && <p data-testid="load-error" style={{ color: 'crimson' }}>{loadError}</p>}

      {v1 && (
        <>
          <p data-testid="v1-account">v1 company (PaymentModule {config.paymentModule}): limits and payee rules are v2 features; showing approvers only.</p>
          <ApproversPanel account={v1.account} registry={v1.registry} revocationList={config.revocationList} />
        </>
      )}

      {account && cfg && pm && (
        <>
          <h2>Limits and rules</h2>
          <table data-testid="config">
            <tbody>
              <tr><td>ENS registry</td><td>{cfg.registry}</td></tr>
              <tr><td>Two approvers above</td><td data-testid="cfg-two">{usdt(cfg.twoApproverThreshold)}</td></tr>
              <tr><td>Per-payment limit</td><td data-testid="cfg-per-payment">{usdt(cfg.perPaymentLimit)}</td></tr>
              <tr><td>30-day limit</td><td data-testid="cfg-monthly">{usdt(cfg.monthlyLimit)}{win && <> (available now: <span data-testid="win-company">{usdt(win[0])}</span>)</>}</td></tr>
              <tr><td>New-payee delay</td><td data-testid="cfg-payee-delay">{cfg.payeeDelay} s</td></tr>
              <tr><td>Fresh ENS proof above</td><td data-testid="cfg-fresh">{usdt(cfg.freshThreshold)} (roles cached within {cfg.maxCacheAge} L1 blocks)</td></tr>
              <tr><td>Agent 30-day cap</td><td data-testid="cfg-agent">{usdt(cfg.agentMonthlyCap)}{win && <> (available now: <span data-testid="win-agent">{usdt(win[1])}</span>)</>}</td></tr>
              <tr><td>Exit accounts</td><td data-testid="cfg-exits">{cfg.exitAccounts.join(', ') || 'none'} (delay {cfg.exitDelay} s)</td></tr>
            </tbody>
          </table>

          <h2>Payees</h2>
          <p>Every payee, including other Tazor companies, must be added by an admin and wait {cfg.payeeDelay} s.</p>
          <table data-testid="payees">
            <tbody>
              {payees.map((p) => {
                const from = Number(p.addedAt) + cfg.payeeDelay;
                return (
                  <tr key={p.payee}><td>{p.payee}</td><td>{p.addedAt === 0n ? 'not added' : now >= from ? 'allowed' : `allowed in ${from - now} s`}</td></tr>
                );
              })}
            </tbody>
          </table>
          <p>
            <label>Payee <input data-testid="payee" value={payee} onChange={(e) => setPayee(e.target.value)} size={44} /></label>{' '}
            <button data-testid="add-payee" disabled={addPayee.busy} onClick={addPayee.run(async () => {
              if (!isAddress(payee)) throw new Error('Enter the payee address.');
              const p = getAddress(payee);
              rememberPayee(account, p);
              return signPolicy(pm, { type: 'AddPayee', message: { account, payee: p, deadline: deadline() } });
            })}>Add payee (admin signs)</button>
          </p>
          {addPayee.error && <p data-testid="add-payee-error" style={{ color: 'crimson' }}>{addPayee.error}</p>}
          {addPayee.out && <Calldata p={addPayee.out} id="add-payee" />}

          <h2>Provisional grant (up to 10 minutes)</h2>
          <p>
            <label>Grantee <input data-testid="grantee" value={grantee} onChange={(e) => setGrantee(e.target.value)} size={44} /></label>{' '}
            <label><input type="checkbox" checked={grantRoles.approver} onChange={(e) => setGrantRoles({ ...grantRoles, approver: e.target.checked })} /> approver</label>{' '}
            <label><input type="checkbox" checked={grantRoles.agent} onChange={(e) => setGrantRoles({ ...grantRoles, agent: e.target.checked })} /> agent</label>{' '}
            <button data-testid="grant" disabled={grant.busy} onClick={grant.run(async () => {
              if (!isAddress(grantee)) throw new Error('Enter the grantee address.');
              const roles = (grantRoles.approver ? ROLE_APPROVER : 0n) | (grantRoles.agent ? ROLE_AGENT : 0n);
              if (roles === 0n) throw new Error('Pick at least one role.');
              return signPolicy(pm, { type: 'ProvisionalGrant', message: { account, grantee: getAddress(grantee), roles, validUntil: nowS() + MAX_GRANT_SECONDS - 30n, deadline: deadline() } });
            })}>Grant (admin signs)</button>
          </p>
          <p>Provisional roles never satisfy the fresh-proof rule and can never include admin.</p>
          {grant.error && <p style={{ color: 'crimson' }}>{grant.error}</p>}
          {grant.out && <Calldata p={grant.out} id="grant" />}

          <h2>Contractor expiry</h2>
          <p>
            <label>Approver <input data-testid="exp-approver" value={expApprover} onChange={(e) => setExpApprover(e.target.value)} size={44} /></label>{' '}
            <label>Valid until <input data-testid="exp-until" type="datetime-local" value={expUntil} onChange={(e) => setExpUntil(e.target.value)} /></label>{' '}
            <button data-testid="set-expiry" disabled={expiry.busy} onClick={expiry.run(async () => {
              if (!isAddress(expApprover)) throw new Error('Enter the approver address.');
              const until = Math.floor(new Date(expUntil).getTime() / 1000);
              if (!Number.isFinite(until)) throw new Error('Pick a date and time.');
              return signPolicy(pm, { type: 'ApproverExpiry', message: { account, approver: getAddress(expApprover), until: BigInt(until), deadline: deadline() } });
            })}>Set expiry (admin signs)</button>
          </p>
          {expiry.error && <p style={{ color: 'crimson' }}>{expiry.error}</p>}
          {expiry.out && <Calldata p={expiry.out} id="expiry" />}

          <h2>Time-locked exit</h2>
          {exit && exit[0] !== '0x0000000000000000000000000000000000000000' ? (
            <p data-testid="exit-status">Exit pending to {exit[0]}: {now >= Number(exit[1])
              ? 'executable now'
              : <>executable in <span data-testid="exit-countdown">{Number(exit[1]) - now}</span> s</>}</p>
          ) : <p data-testid="exit-status">No exit pending.</p>}
          <p>
            <label>Exit account{' '}
              <select data-testid="exit-index" value={exitIndex} onChange={(e) => setExitIndex(Number(e.target.value))}>
                {cfg.exitAccounts.map((a, i) => <option key={a} value={i}>{a}</option>)}
              </select>
            </label>{' '}
            <button data-testid="request-exit" disabled={exitAction.busy || cfg.exitAccounts.length === 0} onClick={exitAction.run(() =>
              signPolicy(pm, { type: 'RequestExit', message: { account, exitIndex: BigInt(exitIndex), deadline: deadline() } }))}>Request exit (approver signs)</button>{' '}
            <button data-testid="cancel-exit" disabled={exitAction.busy} onClick={exitAction.run(() =>
              signPolicy(pm, { type: 'CancelExit', message: { account, deadline: deadline() } }))}>Cancel exit (approver signs)</button>{' '}
            <button data-testid="execute-exit" disabled={exitAction.busy || !exit || exit[0] === '0x0000000000000000000000000000000000000000' || now < Number(exit[1])}
              onClick={exitAction.run(async () => ({ to: pm, data: encodeExecuteExit(account) }))}>Execute exit (anyone)</button>
          </p>
          <p>The exit moves the whole USDT balance to one of the company&apos;s own exit accounts after {cfg.exitDelay} s; any valid approver can cancel it before then.</p>
          {exitAction.error && <p style={{ color: 'crimson' }}>{exitAction.error}</p>}
          {exitAction.out && <Calldata p={exitAction.out} id="exit" />}

          <ApproversPanel account={account} registry={cfg.registry} revocationList={configV2.revocationList} />
        </>
      )}
    </main>
  );
}
