'use client';

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { companyByAccount } from '@/lib/company.ts';
import { DIRECTORY_EVENT, refreshDirectory } from '@/lib/ens-directory.ts';
import { merchantTrustCached, TRUST_TOOLTIP, type Trust } from '@/lib/merchant-trust.ts';
import './merchant-badge.css';

/** Who the customer is paying: the business's ENS name when known, and whether it is verified (WB Soul, simulated on testnet). */
export function MerchantBadge({ merchant }: { merchant: Address }) {
  const [trust, setTrust] = useState<Trust | null>(null);
  const [, rerender] = useState(0);
  useEffect(() => {
    let live = true;
    setTrust(null);
    merchantTrustCached(merchant).then((t) => { if (live) setTrust(t); }, () => { if (live) setTrust({ verified: null }); });
    const sync = () => rerender((n) => n + 1);
    addEventListener(DIRECTORY_EVENT, sync);
    void refreshDirectory().then(sync, () => undefined);
    return () => { live = false; removeEventListener(DIRECTORY_EVENT, sync); };
  }, [merchant]);
  const company = companyByAccount(merchant);

  return (
    <div className="mb" data-testid="merchant-badge" data-verified={trust === null ? 'loading' : String(trust.verified)}>
      {company && <span className="mb-name" data-testid="merchant-ens"><b>{company.name}</b> · {company.ens}</span>}
      {trust === null
        ? <span className="mb-pill mb-loading">Checking the business…</span>
        : trust.verified
          ? <span className="mb-pill mb-ok" title={TRUST_TOOLTIP} tabIndex={0}>✓ Verified business · WhiteBIT (WB Soul, simulated on testnet)</span>
          : trust.verified === false
            ? <span className="mb-pill mb-neutral" title="We could not find a WhiteBIT identity check for this business.">Not verified: check the business before paying large amounts</span>
            : <span className="mb-pill mb-neutral">Verification could not be checked right now</span>}
    </div>
  );
}
