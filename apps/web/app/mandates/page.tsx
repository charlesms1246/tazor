'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatUnits, getAddress, isAddress, isHex, parseUnits, type Hex } from 'viem';
import { signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import {
  PERIODS, decodeAvailable, decodeMandateDigest, decodeMandateOf, encodeAvailableCall, encodeCreateMandate,
  encodeMandateDigestCall, encodeMandateOfCall, encodePull, mandateDigest, mandateRelayerBody, type Mandate,
} from '@/lib/mandate.ts';
import { mergeApprovals, parseApprovals, serializeApproval, type Approval } from '@/lib/payment.ts';
import { ethCall } from '@/lib/rpc.ts';
import { loadMandates, loadPasskey, saveMandate, type StoredMandate } from '@/lib/storage.ts';

const usdt = (v: bigint) => `${formatUnits(v, 6)} USDT`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const days = (s: bigint) => `${Number(s) / 86400} days`;

async function relay(path: string, body: unknown): Promise<Hex> {
  const relayerUrl = getRelayerUrl();
  if (!relayerUrl) throw new Error('Relayer URL is not configured; use the calldata instead.');
  const res = await fetch(`${relayerUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error('Relayer unreachable; use the calldata instead.'); });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `relayer returned ${res.status}`);
  return json.txHash;
}

const TxLink = ({ hash }: { hash: Hex }) => <a href={`${config.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{hash}</a>;

function CreateMandate({ onCreated }: { onCreated: (m: StoredMandate) => void }) {
  const [account, setAccount] = useState('');
  const [payee, setPayee] = useState('');
  const [cap, setCap] = useState('');
  const [period, setPeriod] = useState<keyof typeof PERIODS>('monthly');
  const [expiry, setExpiry] = useState('');
  const [m, setM] = useState<{ mandate: Mandate; digest: Hex } | null>(null);
  const [mine, setMine] = useState<Approval | null>(null);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<Hex | null>(null);
  const [calldata, setCalldata] = useState('');

  const approvals = (() => {
    try { return mergeApprovals(mine ? [mine] : [], pasted.trim() ? parseApprovals(pasted) : []); } catch { return null; }
  })();
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  const onPrepare = run(async () => {
    const mm = config.mandateModule;
    if (!mm) throw new Error('MandateModule address is not configured.');
    if (!isAddress(account) || !isAddress(payee)) throw new Error('Enter the company account and the payee.');
    const exp = Math.floor(new Date(`${expiry}T23:59:59Z`).getTime() / 1000);
    if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) throw new Error('Pick a future expiry date.');
    const mandate: Mandate = {
      account: getAddress(account), payee: getAddress(payee), capPerPeriod: parseUnits(cap || '0', 6),
      period: PERIODS[period], expiry: BigInt(exp), nonce: BigInt(Date.now()),
    };
    if (mandate.capPerPeriod === 0n) throw new Error('Enter a cap per period.');
    const local = mandateDigest(mandate, mm, config.chainId);
    const onchain = decodeMandateDigest(await ethCall(mm, encodeMandateDigestCall(mandate)));
    if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error(`Refusing to sign: on-chain digest ${onchain} differs from ${local}.`);
    setM({ mandate, digest: local }); setMine(null); setTx(null); setCalldata('');
  });

  const onApprove = run(async () => {
    if (!m) return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    setMine({ approver: key.approverAccount, signature: await signDigestWithPasskey(key.credentialId, m.digest, key) });
  });

  const onSubmit = run(async () => {
    if (!m || !approvals?.length) throw new Error('No approvals yet.');
    setTx(await relay('/mandate', mandateRelayerBody(m.mandate, approvals)));
    const stored = { id: m.digest, label: `${usdt(m.mandate.capPerPeriod)} / ${period} to ${m.mandate.payee}` };
    saveMandate(stored);
    onCreated(stored);
  });

  const onCalldata = run(async () => {
    if (!m || !approvals?.length) throw new Error('No approvals yet.');
    setCalldata(encodeCreateMandate(m.mandate, approvals));
    saveMandate({ id: m.digest, label: `${usdt(m.mandate.capPerPeriod)} / ${period} to ${m.mandate.payee}` });
  });

  return (
    <section>
      <h2>New mandate</h2>
      <p>Lets a supplier collect up to a fixed amount per period from the company account, without a new approval each time.</p>
      <p><label>Company account <input data-testid="m-account" value={account} onChange={(e) => setAccount(e.target.value.trim())} size={44} /></label></p>
      <p><label>Payee <input data-testid="m-payee" value={payee} onChange={(e) => setPayee(e.target.value.trim())} size={44} /></label></p>
      <p>
        <label>Cap per period (USDT) <input data-testid="m-cap" value={cap} onChange={(e) => setCap(e.target.value.trim())} size={10} /></label>{' '}
        <label>Period <select data-testid="m-period" value={period} onChange={(e) => setPeriod(e.target.value as keyof typeof PERIODS)}>
          <option value="monthly">Monthly (30 days)</option><option value="weekly">Weekly</option>
        </select></label>{' '}
        <label>Expires <input data-testid="m-expiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
      </p>
      <button data-testid="m-prepare" onClick={onPrepare} disabled={busy}>Review</button>
      {m && (
        <>
          <p data-testid="m-digest">Contract digest matches: <code>{m.digest}</code></p>
          <button data-testid="m-approve" onClick={onApprove} disabled={busy}>Approve with Face ID</button>
          {mine && <p>Your approval: <code style={{ wordBreak: 'break-all' }}>{serializeApproval(mine)}</code></p>}
          <p><label>Approvals from other approvers (JSON)<br /><textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} cols={80} /></label></p>
          <button data-testid="m-submit" onClick={onSubmit} disabled={busy || !approvals?.length}>Create mandate</button>{' '}
          <button data-testid="m-calldata" onClick={onCalldata} disabled={busy || !approvals?.length}>Calldata instead</button>
        </>
      )}
      {error && <p data-testid="m-error" style={{ color: 'crimson' }}>{error}</p>}
      {tx && <p>Created: <TxLink hash={tx} /></p>}
      {calldata && <p>Send to MandateModule {config.mandateModule} on Whitechain:<br /><code style={{ wordBreak: 'break-all' }}>{calldata}</code></p>}
    </section>
  );
}

type Row = StoredMandate & { state?: ReturnType<typeof decodeMandateOf>; available?: bigint; error?: string };

function MandateRow({ row, onRefresh }: { row: Row; onRefresh: () => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ tx?: Hex; calldata?: Hex; error?: string }>({});
  const s = row.state;

  const collect = (viaRelayer: boolean) => async () => {
    setBusy(true); setOut({});
    try {
      const amt = parseUnits(amount || '0', 6);
      if (amt === 0n) throw new Error('Enter an amount.');
      if (row.available !== undefined && amt > row.available) throw new Error(`Only ${usdt(row.available)} available this period.`);
      if (viaRelayer) { setOut({ tx: await relay('/pull', { mandateId: row.id, amount: amt.toString() }) }); onRefresh(); }
      else setOut({ calldata: encodePull(row.id, amt) });
    } catch (e) { setOut({ error: msg(e) }); } finally { setBusy(false); }
  };

  return (
    <tr data-testid="mandate-row">
      <td><code title={row.id}>{row.id.slice(0, 10)}…</code><br />{row.label}</td>
      <td>{s ? <>{usdt(s.cap)} / {days(BigInt(s.period))}<br />to {s.payee}<br />until {new Date(Number(s.expiry) * 1000).toISOString().slice(0, 10)}{s.cancelled ? ' (cancelled)' : ''}</> : row.error ?? '…'}</td>
      <td data-testid="available">{row.available !== undefined ? usdt(row.available) : '…'}</td>
      <td>
        <input value={amount} onChange={(e) => setAmount(e.target.value.trim())} size={8} placeholder="USDT" />{' '}
        <button data-testid="collect" onClick={collect(true)} disabled={busy}>Collect now</button>{' '}
        <button onClick={collect(false)} disabled={busy}>Calldata</button>
        {out.tx && <><br /><TxLink hash={out.tx} /></>}
        {out.calldata && <><br /><code style={{ wordBreak: 'break-all' }}>{out.calldata}</code></>}
        {out.error && <><br /><span style={{ color: 'crimson' }}>{out.error}</span></>}
      </td>
    </tr>
  );
}

export default function MandatesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [trackId, setTrackId] = useState('');

  const refresh = useCallback(async () => {
    const mm = config.mandateModule;
    const list: Row[] = loadMandates();
    setRows(list);
    if (!mm) return;
    setRows(await Promise.all(list.map(async (r) => {
      try {
        const [state, available] = await Promise.all([
          ethCall(mm, encodeMandateOfCall(r.id)).then(decodeMandateOf),
          ethCall(mm, encodeAvailableCall(r.id)).then(decodeAvailable),
        ]);
        return { ...r, state, available };
      } catch (e) {
        return { ...r, error: msg(e) };
      }
    })));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onTrack = () => {
    if (!isHex(trackId) || trackId.length !== 66) return;
    saveMandate({ id: trackId, label: 'tracked' });
    setTrackId('');
    refresh();
  };

  return (
    <main>
      <h1>Mandates</h1>
      <CreateMandate onCreated={() => refresh()} />
      <section>
        <h2>Known mandates</h2>
        <p><label>Track a mandate id <input data-testid="track-id" value={trackId} onChange={(e) => setTrackId(e.target.value.trim())} size={68} /></label>{' '}
          <button data-testid="track" onClick={onTrack}>Track</button></p>
        {rows.length === 0 ? <p>None on this device yet.</p> : (
          <table>
            <thead><tr><th>Mandate</th><th>Terms</th><th>Available now</th><th>Collect</th></tr></thead>
            <tbody>{rows.map((r) => <MandateRow key={r.id} row={r} onRefresh={refresh} />)}</tbody>
          </table>
        )}
      </section>
    </main>
  );
}
