'use client';

import { useEffect, useState } from 'react';
import { createPasskey } from '@/lib/webauthn.ts';
import { predictApproverAccount } from '@/lib/approver.ts';
import { config } from '@/lib/config.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { loadPasskey, savePasskey, type StoredPasskey } from '@/lib/storage.ts';
import { Card, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { AddrChip } from '../_human/chip.tsx';
import { passkeySigner } from '@/lib/approver-signature.ts';
import { admitCommand, admitted, checkAdmission, type Admission } from '@/lib/admission.ts';
import { companyRegistry } from '@/lib/people.ts';
import { useCompany } from '@/lib/company.ts';
import '../_invoice/touch.css';
import './onboard.css';

export default function OnboardPage() {
  const [stored, setStored] = useState<StoredPasskey | null>(null);
  const [signer, setSigner] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deploy, setDeploy] = useState<{ txHash: string | null } | null>(null);

  useEffect(() => setStored(loadPasskey()), []);

  const company = useCompany();
  const [admission, setAdmission] = useState<Admission | null>(null);
  const [checking, setChecking] = useState(false);
  const fullSigner = signer || (stored ? passkeySigner(stored.verifier, stored.x, stored.y) : '');
  let command = '';
  try { command = stored && fullSigner ? admitCommand(stored.approverAccount, fullSigner, company.id) : ''; } catch { command = ''; }
  const onCheck = async () => {
    if (!stored) return;
    setChecking(true);
    try {
      const reg = await companyRegistry(company.account).catch(() => null);
      setAdmission(await checkAdmission(stored.approverAccount, reg?.registry ?? null));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => { if (stored) void onCheck(); }, [stored?.approverAccount, company.account]);
  // Keep checking while an admin runs the command, so the page turns green by itself.
  const done = admission ? admitted(admission) : false;
  useEffect(() => {
    if (!stored || done) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void onCheck(); }, 15_000);
    return () => clearInterval(t);
  }, [stored?.approverAccount, company.account, done]);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'), []);
  const onCopy = () => {
    navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  const onShare = () => {
    navigator.share?.({ title: 'Add me as a Tazor approver', text: `Please add me as an approver for ${company.name}. Run this from the Tazor repo (testnet):\n\n${command}` }).catch(() => {});
  };
  const mark = (v: boolean | null | undefined) => (v === true ? 'done' : v === false ? 'not yet' : 'unknown');

  const onCreate = async () => {
    setBusy(true);
    setError('');
    try {
      if (!config.approverAccountFactory) throw new Error('ApproverAccountFactory address is not configured');
      const key = await createPasskey('tazor-approver');
      const p = await predictApproverAccount(config.approverAccountFactory, key.x, key.y);
      const record = { credentialId: key.credentialId, x: key.x, y: key.y, verifier: p.verifier, approverAccount: p.account };
      setStored(record);
      setSigner(p.signer);
      const saved = savePasskey(record) ? 'Saved on this device.' : 'Could not save on this device; copy the values below.';
      setNote(saved);
      const relayerUrl = getRelayerUrl();
      if (!relayerUrl) return setNote(`${saved} No relayer is set, so your approver account isn't on Whitechain yet; anyone can add it later from the technical details.`);
      const res = await fetch(`${relayerUrl}/approver`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signer: p.signer }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
      if (body.account.toLowerCase() !== p.account.toLowerCase()) throw new Error('relayer returned a different account address');
      setDeploy({ txHash: body.txHash });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const created = !!stored;
  const deployed = !!deploy;
  return (
    <div className="page tz-touch onboard">
      <a href="/company/" className="small" data-testid="back-company" style={{ display: 'inline-block', marginBottom: 8 }}>← Company</a>
      <PageHeader
        title="Approver setup"
        subtitle="Create a passkey on this device; your approver account is derived from it and deployed for you."
      />

      <Card>
        <div style={{ paddingBottom: 12 }}>
          <Pill tone="info" testId="wb-label">Verified by WhiteBIT (simulated on testnet)</Pill>
        </div>
        <div className="steps">
          <div className="step" data-done={created}>
            <span className="step-n">1</span>
            <div className="stack">
              <span style={{ fontWeight: 500 }}>Create a passkey</span>
              <p className="muted">Your passkey stays in your device keychain. Face ID, fingerprint or your device PIN unlocks it whenever you approve.</p>
              <div className="row">
                <button data-testid="create" className="btn btn-primary" onClick={onCreate} disabled={busy}>Create passkey</button>
              </div>
              {error && <Notice tone="negative" testId="error">{error}</Notice>}
              {note && <Notice>{note}</Notice>}
            </div>
          </div>

          <div className="step" data-done={created}>
            <span className="step-n">2</span>
            <div className="stack">
              <span style={{ fontWeight: 500 }}>Your approver account</span>
              {!stored ? (
                <p className="muted">Appears here after you create the passkey: its address is computed from the passkey&apos;s public key.</p>
              ) : (
                <>
                  <dl className="kv">
                    <dt>Approver account</dt>
                    <dd><AddrChip value={stored.approverAccount} name="Your approver account" href={`${config.explorer}/address/${stored.approverAccount}`} testId="approver-account" /></dd>
                  </dl>
                  <details className="onboard-tech">
                    <summary>Technical details (for developers)</summary>
                    <dl className="kv">
                      {signer && <><dt>Signer id</dt><dd><span className="mono break" data-testid="signer">{signer}</span></dd></>}
                      <dt>Passkey x</dt><dd><span className="mono break">{stored.x}</span></dd>
                      <dt>Passkey y</dt><dd><span className="mono break">{stored.y}</span></dd>
                    </dl>
                  </details>
                </>
              )}
            </div>
          </div>

          <div className="step" data-done={deployed}>
            <span className="step-n">3</span>
            <div className="stack">
              <span style={{ fontWeight: 500 }}>Deployed by the relayer</span>
              {deploy ? (
                <p data-testid="deploy">
                  {deploy.txHash
                    ? <>✓ Your approver account is live on Whitechain · <a href={`${config.explorer}/tx/${deploy.txHash}`} target="_blank" rel="noreferrer" data-value={deploy.txHash}>View transaction</a></>
                    : '✓ Your approver account was already live on Whitechain.'}
                </p>
              ) : (
                <p className="muted">The relayer puts your approver account on Whitechain for you. If there is no relayer, anyone can do it later from the technical details.</p>
              )}
            </div>
          </div>

          <div className="step" data-done={admission ? admitted(admission) : false} data-testid="admit-step">
            <span className="step-n">4</span>
            <div className="stack">
              <span style={{ fontWeight: 500 }}>Ask your admin to add you</span>
              {!stored ? (
                <p className="muted">After you create a passkey, send your approver account to an admin of {company.name}. They add you once, and you can approve payments from then on.</p>
              ) : (
                <>
                  <p className="muted">Send this command to an admin of {company.name} ({company.ens}). They run it once from the Tazor repo on testnet: it marks you verified in the WB Soul mirror (simulated KYC), gives you the approver role on ENS and syncs it to Whitechain. This page updates when it&apos;s done.</p>
                  <dl className="kv">
                    <dt>Your approver account</dt>
                    <dd><AddrChip value={stored.approverAccount} href={`${config.explorer}/address/${stored.approverAccount}`} testId="admit-account" /></dd>
                  </dl>
                  {command && (
                    <>
                      <p className="small" style={{ fontWeight: 500, margin: '4px 0 -4px' }}>Command for your admin (copy, don&apos;t edit)</p>
                      <pre className="admit-box" data-testid="admit-command">{command}</pre>
                      <div className="admit-actions">
                        <button type="button" className="btn btn-primary" onClick={onCopy} data-testid="admit-copy">{copied ? 'Copied' : 'Copy command'}</button>
                        {canShare && <button type="button" className="btn" onClick={onShare} data-testid="admit-share">Send to admin…</button>}
                      </div>
                    </>
                  )}
                  <div className="admit-pills">
                    {admission && <>
                      <Pill tone={admission.deployed ? 'positive' : 'neutral'} testId="admit-deployed">Account deployed: {mark(admission.deployed)}</Pill>
                      <Pill tone={admission.verified ? 'info' : 'neutral'} testId="admit-verified">Verified (simulated): {mark(admission.verified)}</Pill>
                      <Pill tone={admission.approver ? 'positive' : 'neutral'} testId="admit-role">Approver on Whitechain: {mark(admission.approver)}</Pill>
                    </>}
                    <button type="button" className="btn btn-sm" onClick={onCheck} disabled={checking} data-testid="admit-check">{checking ? 'Checking…' : 'Check again'}</button>
                  </div>
                  {admission && admitted(admission) && <Notice tone="positive" testId="admit-done">You are an approver for {company.name}. Open a payment link in Approvals to approve it with your passkey.</Notice>}
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
