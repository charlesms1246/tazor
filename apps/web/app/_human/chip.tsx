'use client';

import { CopyButton } from '../_ui/index.tsx';
import { shortAddress } from '@/lib/human.ts';
import './chip.css';

/** An address as a person reads it: name (when known) · 0x1234…abcd · copy · explorer. The full value is in data-value and the tooltip. */
export function AddrChip({ value, name, href, testId }: { value: string; name?: string | null; href?: string; testId?: string }) {
  return (
    <span className="addr-chip" title={value}>
      {name && <span className="addr-chip-name">{name}</span>}
      <span className="mono addr-chip-short" data-testid={testId} data-value={value}>{shortAddress(value)}</span>
      <CopyButton value={value} label="Copy address" />
      {href && <a className="addr-chip-link" href={href} target="_blank" rel="noreferrer">explorer</a>}
    </span>
  );
}
