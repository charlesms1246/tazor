'use client';

import type { ReactNode } from 'react';
import { nameOf } from '@/lib/activity.ts';
import { companyByAccount } from '@/lib/company.ts';
import { config } from '@/lib/config.ts';
import { AddrChip } from '../_human/chip.tsx';

/** Who an address is: the company or member name from ENS, else null. */
export const nameFor = (a: string): string | null => companyByAccount(a)?.ens ?? nameOf(a);

/** An address as people read it: the shared AddrChip with its ENS/company name; full value in title and data-value. */
export function NameChip({ address, link = true, testId }: { address: string; link?: boolean; testId?: string }) {
  return <AddrChip value={address} name={nameFor(address)} href={link ? `${config.explorer}/address/${address}` : undefined} testId={testId} />;
}

/** Raw values (hashes, digests, ids, signatures, calldata, JSON) for developers, collapsed by default. */
export function TechDetails({ children, open, testId }: { children: ReactNode; open?: boolean; testId?: string }) {
  return (
    <details className="tech-details" open={open} data-testid={testId}>
      <summary>Technical details · For developers</summary>
      <div className="stack">{children}</div>
    </details>
  );
}
