import { getAddress, isHex, type Address, type Hex } from 'viem';
import type { InvoiceAuth } from './invoice-auth.ts';
import type { Approval } from './payment.ts';

/**
 * The "Send via Ethereum" fallback delivered from Blockscout's verified-contract write UI (EnsGate is verified on
 * eth-sepolia.blockscout.com), so the wallet signs on a trusted explorer, not on this site.
 * Each field is given in the form Blockscout's inputs take: plain values for string / address / uint, and JSON-style
 * arrays for tuples and lists (a tuple in the struct's field order). Parts and items are also given one by one, for
 * Blockscout versions that show one box per tuple component or per list item.
 */

export const BLOCKSCOUT_SEPOLIA = 'https://eth-sepolia.blockscout.com';
export const blockscoutWriteUrl = (gate: Address) => `${BLOCKSCOUT_SEPOLIA}/address/${gate}?tab=write_contract`;

/** One Blockscout box: `name` is the box's own label there, `label` the plain words shown here. */
export type FieldPart = { name: string; label: string; value: string };
export type ForwardField = {
  name: 'label' | 'account' | 'auth' | 'approvers' | 'signatures';
  type: string;
  title: string;
  what: string;
  value: string;
  preview: string;
  /** How Blockscout shows the field (checked on eth-sepolia Blockscout's forward form). */
  hint: string;
  parts?: FieldPart[];
};

const short = (v: string) => (v.length > 18 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v);
const arr = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(',')}]`;

/** The five forward(...) inputs, in order, for an invoice approval (signatures must be the inner, unwrapped ones). */
export function forwardFields(label: string, auth: InvoiceAuth, approvals: Approval[], invoiceId: string): ForwardField[] {
  const tuple: FieldPart[] = [
    { name: 'invoiceHash', label: 'Invoice reference', value: auth.invoiceHash },
    { name: 'account', label: 'Buyer account', value: auth.account },
    { name: 'payee', label: 'Payee', value: auth.payee },
    { name: 'amount', label: 'Amount in base units (6 decimals)', value: auth.amount.toString() },
    { name: 'expiry', label: 'Expiry (unix time)', value: auth.expiry.toString() },
    { name: 'nonce', label: 'Nonce', value: auth.nonce.toString() },
  ];
  const approvers = approvals.map((a) => a.approver);
  const sigs = approvals.map((a) => a.signature);
  return [
    { name: 'label', type: 'string', title: 'Company name', what: `Your company's ENS name without .taz0r.eth; Ethereum checks the approvers against it.`, value: label, preview: `${label}.taz0r.eth`, hint: 'One box.' },
    { name: 'account', type: 'address', title: 'Company account', what: 'The Whitechain account that pays.', value: auth.account, preview: short(auth.account), hint: 'One box.' },
    {
      name: 'auth', type: 'tuple', title: 'The approved invoice', what: `${invoiceId}: what the approvers signed (invoice, payer, payee, amount, expiry, reference), in this order.`,
      value: arr(tuple.map((p) => p.value)), preview: `${invoiceId} · 6 values`, parts: tuple,
      hint: `Click "auth (tuple)" to open it, then fill its 6 boxes in this order.`,
    },
    {
      name: 'approvers', type: 'address[]', title: 'Approvers', what: `Who approved (${approvers.length}).`,
      value: arr(approvers), preview: approvers.map(short).join(', '), parts: approvers.map((a, i) => ({ name: `approvers[${i}]`, label: `Approver ${i + 1}`, value: a })),
      hint: 'One box per approver; press + for the next.',
    },
    {
      name: 'signatures', type: 'bytes[]', title: 'Approvals', what: 'Their passkey signatures, in the same order as the approvers.',
      value: arr(sigs), preview: `${sigs.length} signature${sigs.length === 1 ? '' : 's'}`, parts: sigs.map((s, i) => ({ name: `signatures[${i}]`, label: `Approval ${i + 1}`, value: s })),
      hint: 'One box per approval, in the same order as the approvers; press + for the next.',
    },
  ];
}

/** Everything in one note a person can keep next to the Blockscout tab. */
export function forwardNote(gate: Address, fields: ForwardField[]): string {
  return [
    `Tazor payment via Ethereum: EnsGate ${gate} on Sepolia`,
    `Open: ${blockscoutWriteUrl(gate)} → Connect wallet (Sepolia) → "forward" → paste → Simulate → Write`,
    ...fields.flatMap((f) => (f.parts?.length
      ? [`${f.name} (${f.type}): ${f.hint}`, ...f.parts.map((p) => `  ${p.name} · ${p.label}: ${p.value}`), `  as one value: ${f.value}`]
      : [`${f.name} (${f.type}): ${f.value}`])),
    'Press Simulate first: it should say success. Then Write.',
  ].join('\n');
}

/** Reads the five values back as forward(...) arguments, exactly as a contract call would take them. */
export function parseForwardFields(values: Record<ForwardField['name'], string>) {
  const list = (s: string) => {
    const v = JSON.parse(s);
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error('expected a JSON array of strings');
    return v as string[];
  };
  const t = list(values.auth);
  if (t.length !== 6) throw new Error('auth must have 6 values');
  const hex = (h: string): Hex => { if (!isHex(h)) throw new Error(`not hex: ${h}`); return h; };
  return [
    values.label,
    getAddress(values.account),
    { invoiceHash: hex(t[0]), account: getAddress(t[1]), payee: getAddress(t[2]), amount: BigInt(t[3]), expiry: BigInt(t[4]), nonce: BigInt(t[5]) },
    list(values.approvers).map((a) => getAddress(a)),
    list(values.signatures).map(hex),
  ] as const;
}
