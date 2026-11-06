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
import { Addr, Card, Empty, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';

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

const TxLink = ({ hash }: { hash: Hex }) => <Addr value={hash} href={`${config.explorer}/tx/${hash}`} />;
const Amount = ({ v }: { v: bigint }) => <><span className="num">{formatUnits(v, 6)}</span> <span className="faint">USDT</span></>;

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

  const step = !m ? 'review' : !mine && !approvals?.length ? 'approve' : 'create';

  return (
    <Card title="Set up a mandate" subtitle="Lets a supplier collect up to a fixed amount per period from the company account, without a new approval each time.">
      <div className="fields">
        <div className="fields-2">
          <Field label="Company account">
            <input className="input mono" data-testid="m-account" value={account} onChange={(e) => setAccount(e.target.value.trim())} placeholder="0x…" />
          </Field>
          <Field label="Payee">
            <input className="input mono" data-testid="m-payee" value={payee} onChange={(e) => setPayee(e.target.value.trim())} placeholder="0x…" />
          </Field>
        </div>
        <div className="grid-3">
          <Field label="Cap per period">
            <div className="input-affix">
              <input className="input num" style={{ textAlign: 'right' }} inputMode="decimal" data-testid="m-cap" value={cap} onChange={(e) => setCap(e.target.value.trim())} placeholder="0.00" />
              <span>USDT</span>
            </div>
          </Field>
          <Field label="Period">
            <select className="select" data-testid="m-period" value={period} onChange={(e) => setPeriod(e.target.value as keyof typeof PERIODS)}>
              <option value="monthly">Monthly (30 days)</option><option value="weekly">Weekly</option>
            </select>
          </Field>
          <Field label="Expires">
            <input className="input" data-testid="m-expiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </Field>
        </div>
        <div><button className={`btn${step === 'review' ? ' btn-primary' : ''}`} data-testid="m-prepare" onClick={onPrepare} disabled={busy}>Review</button></div>
        {m && (
          <div className="well stack">
            <p className="small muted" data-testid="m-digest">Contract digest matches: <code className="break">{m.digest}</code></p>
            <div><button className={`btn${step === 'approve' ? ' btn-primary' : ''}`} data-testid="m-approve" onClick={onApprove} disabled={busy}>Approve with Face ID</button></div>
            {mine && <p className="small">Your approval: <code className="break">{serializeApproval(mine)}</code></p>}
            <Field label="Approvals from other approvers" hint="Paste the JSON a second approver sends you, if the cap needs two.">
              <textarea className="textarea mono" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} />
            </Field>
            <div className="row">
              <button className={`btn${step === 'create' ? ' btn-primary' : ''}`} data-testid="m-submit" onClick={onSubmit} disabled={busy || !approvals?.length}>Create mandate</button>
              <button className="btn" data-testid="m-calldata" onClick={onCalldata} disabled={busy || !approvals?.length}>Calldata instead</button>
            </div>
          </div>
        )}
        {error && <Notice tone="negative"><span data-testid="m-error">{error}</span></Notice>}
        {tx && <Notice tone="positive">Mandate created: <TxLink hash={tx} /></Notice>}
        {calldata && <div className="well"><p className="small muted">Send to MandateModule <span className="mono break">{config.mandateModule}</span> on Whitechain:</p><code className="break small">{calldata}</code></div>}
      </div>
    </Card>
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

  const expired = s ? Number(s.expiry) * 1000 < Date.now() : false;

  return (
    <tr data-testid="mandate-row">
      <td>
        {s ? <span className="mono break">{s.payee}</span> : <span className="faint">{row.label}</span>}
        <span className="cell-sub"><span className="mono" title={row.id}>{row.id.slice(0, 10)}…</span>{s && <> · until {new Date(Number(s.expiry) * 1000).toISOString().slice(0, 10)}</>}</span>
      </td>
      <td className="num">{s ? <><Amount v={s.cap} /> / {days(BigInt(s.period))}</> : row.error ? <span className="error-text">{row.error}</span> : '…'}</td>
      <td>{s ? (s.cancelled ? <Pill tone="negative">cancelled</Pill> : expired ? <Pill>expired</Pill> : <Pill tone="positive" dot>active</Pill>) : <Pill>loading</Pill>}</td>
      <td className="num" data-testid="available">{row.available !== undefined ? <Amount v={row.available} /> : '…'}</td>
      <td>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <div className="input-affix" style={{ width: 140 }}>
            <input className="input num" style={{ textAlign: 'right', height: 30 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0.00" aria-label="Amount to collect" />
            <span>USDT</span>
          </div>
          <button className="btn btn-sm" data-testid="collect" onClick={collect(true)} disabled={busy}>Collect now</button>
          <button className="btn btn-sm btn-ghost" onClick={collect(false)} disabled={busy}>Calldata</button>
        </div>
        {out.tx && <span className="cell-sub">Collected: <TxLink hash={out.tx} /></span>}
        {out.calldata && <span className="cell-sub"><code className="break">{out.calldata}</code></span>}
        {out.error && <div style={{ marginTop: 8 }}><Notice tone="negative">{out.error}</Notice></div>}
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
    <div className="page">
      <PageHeader title="Mandates" subtitle="Direct debits: a supplier collects up to a fixed amount each period, within limits your approvers signed." />

      <Card title="Mandates" subtitle="Tracked on this device, with live terms and what can be collected now." flush>
        {rows.length === 0 ? (
          <div style={{ padding: '0 24px 16px' }}><Empty>No mandates on this device yet. Set one up below, or track an existing mandate id.</Empty></div>
        ) : (
          <div className="table-wrap"><table className="table table-stack">
            <thead><tr><th>Payee</th><th className="num">Amount per period</th><th>Status</th><th className="num">Available now</th><th className="num">Collect</th></tr></thead>
            <tbody>{rows.map((r) => <MandateRow key={r.id} row={r} onRefresh={refresh} />)}</tbody>
          </table></div>
        )}
        <div style={{ padding: '16px 24px 24px' }}>
          <Field label="Track a mandate id">
            <div className="input-group">
              <input className="input mono" data-testid="track-id" value={trackId} onChange={(e) => setTrackId(e.target.value.trim())} placeholder="0x…" />
              <button className="btn" data-testid="track" onClick={onTrack}>Track</button>
            </div>
          </Field>
        </div>
      </Card>

      <CreateMandate onCreated={() => refresh()} />
    </div>
  );
}
