'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatUnits, getAddress, isAddress, isHex, parseUnits, type Address, type Hex } from 'viem';
import { signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { RELAYER_WRITE_TIMEOUT_MS, relayerFailure } from '@/lib/relayer-off.ts';
import {
  PERIODS, decodeAvailable, decodeMandateDigest, decodeMandateOf, encodeAvailableCall, encodeCreateMandate,
  encodeMandateDigestCall, encodePull, findMandate, mandateDigest, mandateModuleFor, mandateRelayerBody, type Mandate, type MandateModuleRef,
} from '@/lib/mandate.ts';
import { dayText, periodText, shortRef, usdtText } from '@/lib/readable.ts';
import { NameChip, TechDetails, nameFor } from '../_readable/index.tsx';
import { mergeApprovals, parseApprovals, serializeApproval, type Approval } from '@/lib/payment.ts';
import { ethCall } from '@/lib/rpc.ts';
import { loadMandates, loadPasskey, saveMandate, type StoredMandate } from '@/lib/storage.ts';
import { Card, CopyButton, Empty, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { HistoryTimeline } from '../_invoice/history.tsx';
import { useSubjectHistory } from '@/lib/chain-history.ts';
import { recordEvent } from '@/lib/events.ts';
import { usdt2dp } from '@/lib/export.ts';
import { companyByAccount } from '@/lib/company.ts';

const usdt = usdtText;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const partyName = (a: string) => companyByAccount(a)?.ens ?? nameFor(a) ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
/** "Mandate to Sandbox Supplier · up to 0.30 USDT / 30 days · #a1b2c3" */
const mandateTitle = (payee: string, cap: bigint, period: bigint, id: string) => `Mandate to ${partyName(payee)} · up to ${usdt(cap)} / ${periodText(period)} · ${shortRef(id)}`;

async function relay(path: string, body: unknown): Promise<Hex> {
  const relayerUrl = getRelayerUrl();
  if (!relayerUrl) throw new Error('Relayer URL is not configured; use the calldata instead.');
  const res = await fetch(`${relayerUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(RELAYER_WRITE_TIMEOUT_MS),
  }).catch((e) => { throw relayerFailure(e, 'You can also use the calldata instead.'); });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `relayer returned ${res.status}`);
  return json.txHash;
}

/** A transaction as a link; the hash stays in href and data-value. */
const TxLink = ({ hash }: { hash: Hex }) => <a href={`${config.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" data-value={hash}>View transaction ↗</a>;
const Amount = ({ v }: { v: bigint }) => <><span className="num">{usdtText(v).replace(' USDT', '')}</span> <span className="faint">USDT</span></>;

function CreateMandate({ onCreated }: { onCreated: (m: StoredMandate) => void }) {
  const [account, setAccount] = useState('');
  const [payee, setPayee] = useState('');
  const [cap, setCap] = useState('');
  const [period, setPeriod] = useState<keyof typeof PERIODS>('monthly');
  const [expiry, setExpiry] = useState('');
  const [m, setM] = useState<{ mandate: Mandate; digest: Hex; module: MandateModuleRef } | null>(null);
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
    if (!isAddress(account) || !isAddress(payee)) throw new Error('Enter the company account and the payee.');
    // v2 companies use MandateModuleV2 (its own digest domain); others the v1 module
    const module = await mandateModuleFor(getAddress(account));
    if (!module) throw new Error('MandateModule address is not configured.');
    const mm = module.address;
    const exp = Math.floor(new Date(`${expiry}T23:59:59Z`).getTime() / 1000);
    if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) throw new Error('Pick a future expiry date.');
    const mandate: Mandate = {
      account: getAddress(account), payee: getAddress(payee), capPerPeriod: parseUnits(cap || '0', 6),
      period: PERIODS[period], expiry: BigInt(exp), nonce: BigInt(Date.now()),
    };
    if (mandate.capPerPeriod === 0n) throw new Error('Enter a cap per period.');
    const local = mandateDigest(mandate, mm, config.chainId, module.version);
    const onchain = decodeMandateDigest(await ethCall(mm, encodeMandateDigestCall(mandate)));
    if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error('Refusing to sign: the contract describes a different mandate than this page (see Technical details).');
    setM({ mandate, digest: local, module }); setMine(null); setTx(null); setCalldata('');
  });

  const onApprove = run(async () => {
    if (!m) return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    setMine({ approver: key.approverAccount, signature: await signDigestWithPasskey(key.credentialId, m.digest, key) });
  });

  const onSubmit = run(async () => {
    if (!m || !approvals?.length) throw new Error('No approvals yet.');
    const hash = await relay('/mandate', mandateRelayerBody(m.mandate, approvals));
    setTx(hash);
    recordEvent({
      subject: m.digest, kind: 'mandate-created', at: Date.now(),
      title: `Mandate to ${partyName(m.mandate.payee)} set up: up to ${formatUnits(m.mandate.capPerPeriod, 6)} USDT ${period}`,
      actor: partyName(m.mandate.account), tx: hash, chain: 'whitechain',
    });
    const stored = { id: m.digest, label: mandateTitle(m.mandate.payee, m.mandate.capPerPeriod, m.mandate.period, m.digest) };
    saveMandate(stored);
    onCreated(stored);
  });

  const onCalldata = run(async () => {
    if (!m || !approvals?.length) throw new Error('No approvals yet.');
    setCalldata(encodeCreateMandate(m.mandate, approvals));
    saveMandate({ id: m.digest, label: mandateTitle(m.mandate.payee, m.mandate.capPerPeriod, m.mandate.period, m.digest) });
  });

  const step = !m ? 'review' : !mine && !approvals?.length ? 'approve' : 'create';

  return (
    <Card title="Set up a mandate" subtitle="Approve once; the supplier then collects up to the cap each period, until it expires.">
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
            <p className="small muted" data-testid="m-digest" data-value={m.digest}>
              ✓ The contract agrees: {mandateTitle(m.mandate.payee, m.mandate.capPerPeriod, m.mandate.period, m.digest)}, until {dayText(m.mandate.expiry)}.
            </p>
            <div><button className={`btn${step === 'approve' ? ' btn-primary' : ''}`} data-testid="m-approve" onClick={onApprove} disabled={busy}>Approve with passkey</button></div>
            {mine && <p className="small row" style={{ gap: 6 }}>Your approval is ready. If the amount needs a second approver, send them your approval: <CopyButton value={serializeApproval(mine)} label="Copy approval" /></p>}
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
        {tx && <Notice tone="positive" testId="m-tx">Mandate created: <TxLink hash={tx} /></Notice>}
        {calldata && <Notice>Transaction data ready: see Technical details below.</Notice>}
        {m && (
          <TechDetails open={!!calldata}>
            <dl className="kv">
              <dt>Mandate digest (id)</dt><dd><code className="break small">{m.digest}</code> <CopyButton value={m.digest} /></dd>
              <dt>MandateModule</dt><dd><code className="break small">{m.module.address}</code> (v{m.module.version})</dd>
              <dt>Nonce</dt><dd className="mono">{m.mandate.nonce.toString()}</dd>
            </dl>
            {mine && <><p className="small muted">Your approval (JSON)</p><code className="break small">{serializeApproval(mine)}</code></>}
            {calldata && <><p className="small muted">Send to MandateModule <span className="mono break">{m.module.address}</span> on Whitechain:</p><code className="break small">{calldata}</code></>}
          </TechDetails>
        )}
      </div>
    </Card>
  );
}

type Row = StoredMandate & { state?: ReturnType<typeof decodeMandateOf>; available?: bigint; module?: MandateModuleRef; error?: string };

/** A mandate's activity: this device's events merged with what the chain shows (created, collected, cancelled). */
function MandateHistory({ id, account }: { id: string; account: Address | null }) {
  const h = useSubjectHistory(id, account);
  return <HistoryTimeline events={h.events} loading={h.loading} error={h.error} testId="mandate-timeline" />;
}

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
      if (viaRelayer) {
        const hash = await relay('/pull', { mandateId: row.id, amount: amt.toString() });
        setOut({ tx: hash });
        recordEvent({
          subject: row.id, kind: 'collected', at: Date.now(),
          title: `Mandate to ${s ? partyName(s.payee) : 'payee'} collected ${usdt2dp(amt)} USDT`,
          actor: s ? partyName(s.payee) : undefined, tx: hash, chain: 'whitechain',
        });
        onRefresh();
      }
      else setOut({ calldata: encodePull(row.id, amt) });
    } catch (e) { setOut({ error: msg(e) }); } finally { setBusy(false); }
  };

  const expired = s ? Number(s.expiry) * 1000 < Date.now() : false;
  const [open, setOpen] = useState(false);

  return (
    <>
    <tr data-testid="mandate-row">
      <td>
        {s ? <span>Mandate to <NameChip address={s.payee} /></span> : <span className="faint">{row.label}</span>}
        <span className="cell-sub"><span title={row.id} data-value={row.id}>{shortRef(row.id)}</span>{s && <> · until {dayText(s.expiry)}</>}</span>
      </td>
      <td className="num">{s ? <><Amount v={BigInt(s.cap)} /> / {periodText(BigInt(s.period))}</> : row.error ? <span className="error-text">{row.error}</span> : '…'}</td>
      <td>{s ? (s.cancelled ? <Pill tone="negative">cancelled</Pill> : expired ? <Pill>expired</Pill> : <Pill tone="positive" dot>active</Pill>) : <Pill>loading</Pill>}</td>
      <td className="num" data-testid="available">{row.available !== undefined ? <Amount v={row.available} /> : '…'}</td>
      <td style={{ gridColumn: '1 / -1', minWidth: 260 }}>
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <div className="input-affix" style={{ flex: 1, minWidth: 0 }}>
              <input className="input num" style={{ textAlign: 'right' }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0.00" aria-label="Amount to collect" />
              <span>USDT</span>
            </div>
            <button className="btn" data-testid="collect" onClick={collect(true)} disabled={busy}>Collect now</button>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={collect(false)} disabled={busy}>Calldata</button>
            <button className="btn btn-ghost" data-testid="mandate-activity" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide activity' : 'Activity'}</button>
          </div>
          {out.tx && <span className="small">Collected: <TxLink hash={out.tx} /></span>}
          {out.calldata && (
            <TechDetails open>
              <p className="small muted">Send to MandateModule <span className="mono break">{row.module?.address ?? config.mandateModule}</span> on Whitechain:</p>
              <code className="break small">{out.calldata}</code>
            </TechDetails>
          )}
          {out.error && <Notice tone="negative">{out.error}</Notice>}
        </div>
      </td>
    </tr>
    {open && (
      <tr data-testid="mandate-detail">
        <td colSpan={5}><MandateHistory id={row.id} account={s?.account ?? null} /></td>
      </tr>
    )}
    </>
  );
}

export default function MandatesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [trackId, setTrackId] = useState('');

  const refresh = useCallback(async () => {
    const list: Row[] = loadMandates();
    setRows(list);
    setRows(await Promise.all(list.map(async (r) => {
      try {
        // a mandate lives on MandateModuleV2 (v2 companies) or v1: look in both
        const found = await findMandate(r.id as Hex);
        if (!found) return { ...r, error: 'Not found on Whitechain yet' };
        const available = decodeAvailable(await ethCall(found.ref.address, encodeAvailableCall(r.id as Hex)));
        return { ...r, state: found.state, available, module: found.ref };
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
      <PageHeader title="Collect" subtitle="Direct debits: approve once, and a supplier collects up to a fixed amount each period." />

      <Card title="Mandates" subtitle="What each supplier can collect right now." flush>
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
