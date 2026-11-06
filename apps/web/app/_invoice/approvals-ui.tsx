'use client';

import type { Hex } from 'viem';
import { shareText } from '@/lib/approval-code.ts';
import { serializeApproval, type Approval } from '@/lib/payment.ts';
import { ensLabelOf } from '@/lib/ens-directory.ts';
import { partyName } from '@/lib/story.ts';
import { toast } from './toast.tsx';

/** A person-readable name for an approver account: ENS member/company name if known, else a short address. */
export const approverName = (a: string) => ensLabelOf(a) ?? partyName(a);

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "Signed by you (passkey) at 20:41" + "Share my approval" (copies a readable line with a TZA1 code). */
export function MyApproval({ approval, at, digest, what, testId, shareTestId }: {
  approval: Approval; at: number; digest: Hex; what: string; testId: string; shareTestId: string;
}) {
  const text = shareText(approval, digest, what);
  return (
    <div className="well stack" style={{ gap: 8 }}>
      <p style={{ margin: 0 }} data-testid={testId} data-value={serializeApproval(approval)} data-code={text}>
        <b>✓ Signed by you (passkey) at {time(at)}</b>
        <span className="cell-sub">Approval reference {what}</span>
      </p>
      <div className="row">
        <button
          type="button" className="btn btn-sm" data-testid={shareTestId}
          onClick={() => navigator.clipboard?.writeText(text).then(() => toast('Approval copied: send it to the second approver'), () => toast('Could not copy the approval', 'error'))}
        >Share my approval</button>
        <span className="small muted">They paste it on this same invoice.</span>
      </div>
    </div>
  );
}

/** "Approval from Priya Sharma ✓" for each approval that was pasted (or collected). */
export function ApprovalNames({ approvals, testId }: { approvals: Approval[]; testId: string }) {
  if (approvals.length === 0) return null;
  return (
    <ul className="approval-names" data-testid={testId}>
      {approvals.map((a) => (
        <li key={a.approver} data-approver={a.approver}>Approval from <b>{approverName(a.approver)}</b> ✓</li>
      ))}
    </ul>
  );
}
