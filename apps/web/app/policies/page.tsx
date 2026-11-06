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
import { Card, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';

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

const Amount = ({ v }: { v: bigint }) => <><span className="num">{formatUnits(v, 6)}</span> <span className="faint">USDT</span></>;
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
    <div className="well stack" data-testid={`${id}-out`}>
      {p.digest && <p className="small muted">Signed digest (matches the contract): <code className="break" data-testid={`${id}-digest`}>{p.digest}</code></p>}
      <div>
        <p className="small muted">To <span className="mono break">{p.to}</span> on Whitechain Sepolia. Anyone can send it.</p>
        <code className="break small" data-testid={`${id}-calldata`}>{p.data}</code>
      </div>
      <div className="row">
        <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(JSON.stringify({ to: p.to, data: p.data })).catch(() => undefined)}>Copy calldata</button>
        <button className="btn btn-sm" onClick={() => sendOnWhitechain(p.to, p.data).then(setHash, (e) => setErr(msg(e)))}>Send with your wallet</button>
      </div>
      {hash && <p className="small">Sent: <a className="mono break" href={`${config.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{hash}</a></p>}
      {err && <Notice tone="negative">{err}</Notice>}
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

  const hasExit = !!exit && exit[0] !== ZERO_ADDR;

  return (
    <div className="page">
      <PageHeader title="Policies" subtitle="Spending limits, payee rules, temporary access and the time-locked exit for a company account." />

      <Card title="Company account">
        <div className="fields">
          <Field label="Account address">
            <div className="input-group">
              <input className="input mono" data-testid="account" value={input} onChange={(e) => setInput(e.target.value)} />
              <button className="btn btn-primary" data-testid="load" onClick={load}>Load</button>
            </div>
          </Field>
          {loadError && <Notice tone="negative"><span data-testid="load-error">{loadError}</span></Notice>}
          {v1 && (
            <Notice tone="info"><span data-testid="v1-account">v1 company (PaymentModule <span className="mono break">{config.paymentModule}</span>): limits and payee rules are v2 features; showing approvers only.</span></Notice>
          )}
        </div>
      </Card>

      {v1 && <ApproversPanel account={v1.account} registry={v1.registry} revocationList={config.revocationList} />}

      {account && cfg && pm && (
        <>
          <Card title="Limits and rules" subtitle="Enforced by PaymentModule v2 on every payment.">
            <dl className="kv" data-testid="config">
              <dt>ENS registry</dt><dd className="mono">{cfg.registry}</dd>
              <dt>Two approvers above</dt><dd data-testid="cfg-two"><Amount v={cfg.twoApproverThreshold} /></dd>
              <dt>Per-payment limit</dt><dd data-testid="cfg-per-payment"><Amount v={cfg.perPaymentLimit} /></dd>
              <dt>30-day limit</dt>
              <dd data-testid="cfg-monthly"><Amount v={cfg.monthlyLimit} />{win && <span className="muted"> (available now: <span data-testid="win-company"><Amount v={win[0]} /></span>)</span>}</dd>
              <dt>New-payee delay</dt><dd className="num" data-testid="cfg-payee-delay">{cfg.payeeDelay} s</dd>
              <dt>Fresh ENS proof above</dt><dd data-testid="cfg-fresh"><Amount v={cfg.freshThreshold} /> <span className="muted">(roles cached within {cfg.maxCacheAge} L1 blocks)</span></dd>
              <dt>Agent 30-day cap</dt>
              <dd data-testid="cfg-agent"><Amount v={cfg.agentMonthlyCap} />{win && <span className="muted"> (available now: <span data-testid="win-agent"><Amount v={win[1]} /></span>)</span>}</dd>
              <dt>Exit accounts</dt><dd data-testid="cfg-exits"><span className="mono">{cfg.exitAccounts.join(', ') || 'none'}</span> <span className="muted">(delay {cfg.exitDelay} s)</span></dd>
            </dl>
          </Card>

          <Card title="Payees" subtitle={`Every payee, including other Tazor companies, must be added by an admin and wait ${cfg.payeeDelay} s.`}>
            <div className="fields">
              {payees.length === 0 ? <div className="empty">No payees tracked on this device yet. Add one below.</div> : (
                <div className="table-wrap"><table className="table table-stack" data-testid="payees">
                  <thead><tr><th>Payee</th><th>Status</th></tr></thead>
                  <tbody>
                    {payees.map((p) => {
                      const from = Number(p.addedAt) + cfg.payeeDelay;
                      return (
                        <tr key={p.payee}>
                          <td className="mono break">{p.payee}</td>
                          <td>{p.addedAt === 0n ? <Pill>not added</Pill> : now >= from ? <Pill tone="positive">allowed</Pill> : <Pill tone="warning">{`allowed in ${from - now} s`}</Pill>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
              )}
              <Field label="Payee address">
                <div className="input-group">
                  <input className="input mono" data-testid="payee" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="0x…" />
                  <button className="btn" data-testid="add-payee" disabled={addPayee.busy} onClick={addPayee.run(async () => {
                    if (!isAddress(payee)) throw new Error('Enter the payee address.');
                    const p = getAddress(payee);
                    rememberPayee(account, p);
                    return signPolicy(pm, { type: 'AddPayee', message: { account, payee: p, deadline: deadline() } });
                  })}>Add payee (admin signs)</button>
                </div>
              </Field>
              {addPayee.error && <Notice tone="negative"><span data-testid="add-payee-error">{addPayee.error}</span></Notice>}
              {addPayee.out && <Calldata p={addPayee.out} id="add-payee" />}
            </div>
          </Card>

          <div className="grid-2">
            <Card title="Provisional grant" subtitle="Up to 10 minutes. Never satisfies the fresh-proof rule and can never include admin.">
              <div className="fields">
                <Field label="Grantee">
                  <input className="input mono" data-testid="grantee" value={grantee} onChange={(e) => setGrantee(e.target.value)} placeholder="0x…" />
                </Field>
                <div className="row">
                  <label className="check"><input type="checkbox" checked={grantRoles.approver} onChange={(e) => setGrantRoles({ ...grantRoles, approver: e.target.checked })} /> approver</label>
                  <label className="check"><input type="checkbox" checked={grantRoles.agent} onChange={(e) => setGrantRoles({ ...grantRoles, agent: e.target.checked })} /> agent</label>
                </div>
                <div><button className="btn" data-testid="grant" disabled={grant.busy} onClick={grant.run(async () => {
                  if (!isAddress(grantee)) throw new Error('Enter the grantee address.');
                  const roles = (grantRoles.approver ? ROLE_APPROVER : 0n) | (grantRoles.agent ? ROLE_AGENT : 0n);
                  if (roles === 0n) throw new Error('Pick at least one role.');
                  return signPolicy(pm, { type: 'ProvisionalGrant', message: { account, grantee: getAddress(grantee), roles, validUntil: nowS() + MAX_GRANT_SECONDS - 30n, deadline: deadline() } });
                })}>Grant (admin signs)</button></div>
                {grant.error && <Notice tone="negative">{grant.error}</Notice>}
                {grant.out && <Calldata p={grant.out} id="grant" />}
              </div>
            </Card>

            <Card title="Contractor expiry" subtitle="An approver stops being able to approve after this time.">
              <div className="fields">
                <Field label="Approver">
                  <input className="input mono" data-testid="exp-approver" value={expApprover} onChange={(e) => setExpApprover(e.target.value)} placeholder="0x…" />
                </Field>
                <Field label="Valid until">
                  <input className="input" data-testid="exp-until" type="datetime-local" value={expUntil} onChange={(e) => setExpUntil(e.target.value)} />
                </Field>
                <div><button className="btn" data-testid="set-expiry" disabled={expiry.busy} onClick={expiry.run(async () => {
                  if (!isAddress(expApprover)) throw new Error('Enter the approver address.');
                  const until = Math.floor(new Date(expUntil).getTime() / 1000);
                  if (!Number.isFinite(until)) throw new Error('Pick a date and time.');
                  return signPolicy(pm, { type: 'ApproverExpiry', message: { account, approver: getAddress(expApprover), until: BigInt(until), deadline: deadline() } });
                })}>Set expiry (admin signs)</button></div>
                {expiry.error && <Notice tone="negative">{expiry.error}</Notice>}
                {expiry.out && <Calldata p={expiry.out} id="expiry" />}
              </div>
            </Card>
          </div>

          <Card title="Time-locked exit" subtitle={`Moves the whole USDT balance to one of the company's own exit accounts after ${cfg.exitDelay} s. Any valid approver can cancel it before then.`}>
            <div className="fields">
              {hasExit ? (
                <Notice tone="warning"><span data-testid="exit-status">Exit pending to <span className="mono break">{exit![0]}</span>: {now >= Number(exit![1])
                  ? 'executable now'
                  : <>executable in <span className="num" data-testid="exit-countdown">{Number(exit![1]) - now}</span> s</>}</span></Notice>
              ) : <p className="muted" data-testid="exit-status">No exit pending.</p>}
              <Field label="Exit account">
                <select className="select mono" data-testid="exit-index" value={exitIndex} onChange={(e) => setExitIndex(Number(e.target.value))}>
                  {cfg.exitAccounts.map((a, i) => <option key={a} value={i}>{a}</option>)}
                </select>
              </Field>
              <div className="row">
                <button className="btn" data-testid="request-exit" disabled={exitAction.busy || cfg.exitAccounts.length === 0} onClick={exitAction.run(() =>
                  signPolicy(pm, { type: 'RequestExit', message: { account, exitIndex: BigInt(exitIndex), deadline: deadline() } }))}>Request exit (approver signs)</button>
                <button className="btn" data-testid="cancel-exit" disabled={exitAction.busy} onClick={exitAction.run(() =>
                  signPolicy(pm, { type: 'CancelExit', message: { account, deadline: deadline() } }))}>Cancel exit (approver signs)</button>
                <button className="btn" data-testid="execute-exit" disabled={exitAction.busy || !hasExit || now < Number(exit![1])}
                  onClick={exitAction.run(async () => ({ to: pm, data: encodeExecuteExit(account) }))}>Execute exit (anyone)</button>
              </div>
              {exitAction.error && <Notice tone="negative">{exitAction.error}</Notice>}
              {exitAction.out && <Calldata p={exitAction.out} id="exit" />}
            </div>
          </Card>

          <ApproversPanel account={account} registry={cfg.registry} revocationList={configV2.revocationList} />
        </>
      )}
    </div>
  );
}
