/**
 * Indian GST details for an invoice: supplier and buyer GSTIN, place of supply, HSN/SAC per line, and the CGST+SGST
 * (same state) or IGST (other state) split of the tax.
 *
 * DISPLAY-ONLY METADATA. These details travel inside the same encrypted payment link (as a `gst` key next to the
 * invoice fields) but are NOT part of the signed invoice: parseInvoice ignores unknown keys and the invoice hash is
 * keccak256 of the canonical invoice JSON, which never includes them. So approvals, the on-chain digest and payment
 * matching are unchanged, and older links (or decoders) without GST keep working. The tax itself is still one final
 * line ("GST 18%") that settles on chain; the split is shown on the invoice paper and PDF.
 */

export type GstMeta = {
  supplierGstin?: string;
  buyerGstin?: string;
  /** Two-digit state code of the place of supply. */
  placeOfSupply?: string;
  /** HSN/SAC code per invoice line, aligned with the lines (the tax line excluded). */
  hsn?: string[];
};

export const STATES: [string, string][] = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
];
export const stateName = (code?: string) => STATES.find(([c]) => c === code)?.[1] ?? null;

const GSTIN_RE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const isGstin = (v: string) => GSTIN_RE.test(v.trim().toUpperCase()) && stateName(v.trim().slice(0, 2)) !== null;
export const stateOfGstin = (v?: string) => (v && isGstin(v) ? v.trim().slice(0, 2) : null);
const HSN_RE = /^\d{4,8}$/;
export const isHsn = (v: string) => HSN_RE.test(v.trim());

/** The problem with a GST form, if any (all fields are optional; what is filled must be valid). */
export function gstProblem(m: GstMeta): string | null {
  if (m.supplierGstin && !isGstin(m.supplierGstin)) return 'Supplier GSTIN must be 15 characters like 27AABCB1234C1Z5.';
  if (m.buyerGstin && !isGstin(m.buyerGstin)) return 'Buyer GSTIN must be 15 characters like 27AACCA5678D1Z2.';
  if (m.placeOfSupply && !stateName(m.placeOfSupply)) return 'Pick the place of supply from the list.';
  const bad = (m.hsn ?? []).findIndex((h) => h && !isHsn(h));
  if (bad >= 0) return `Line ${bad + 1}: HSN/SAC must be 4 to 8 digits.`;
  return null;
}

/** Only the filled, normalised fields; null when nothing is filled. */
export function cleanGst(m: GstMeta | null | undefined): GstMeta | null {
  if (!m) return null;
  const out: GstMeta = {};
  if (m.supplierGstin?.trim()) out.supplierGstin = m.supplierGstin.trim().toUpperCase();
  if (m.buyerGstin?.trim()) out.buyerGstin = m.buyerGstin.trim().toUpperCase();
  if (m.placeOfSupply?.trim()) out.placeOfSupply = m.placeOfSupply.trim();
  if (m.hsn?.some((h) => h?.trim())) out.hsn = m.hsn.map((h) => h?.trim() ?? '');
  return Object.keys(out).length ? out : null;
}

/** Reads GST metadata found in a decrypted link (anything malformed is dropped, never trusted). */
export function readGst(raw: unknown): GstMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const m: GstMeta = {
    supplierGstin: str(o.supplierGstin), buyerGstin: str(o.buyerGstin), placeOfSupply: str(o.placeOfSupply),
    hsn: Array.isArray(o.hsn) ? o.hsn.map((h) => (typeof h === 'string' ? h : '')) : undefined,
  };
  return gstProblem(m) ? null : cleanGst(m);
}

export type TaxSplit = { kind: 'cgst-sgst' | 'igst' | 'none'; parts: { label: string; rate: string; amount: bigint }[] };

/**
 * How a tax amount splits: same state (supplier GSTIN state = place of supply) → CGST + SGST, half each (CGST takes
 * the lower half when the amount is odd); different state → IGST; unknown states → no split.
 */
export function gstSplit(tax: { rate: string; amount: bigint }, m: GstMeta | null): TaxSplit {
  const from = stateOfGstin(m?.supplierGstin);
  const to = m?.placeOfSupply ?? stateOfGstin(m?.buyerGstin);
  if (!from || !to) return { kind: 'none', parts: [] };
  if (from !== to) return { kind: 'igst', parts: [{ label: 'IGST', rate: tax.rate, amount: tax.amount }] };
  const half = (Number(tax.rate) / 2).toString();
  const cgst = tax.amount / 2n;
  return { kind: 'cgst-sgst', parts: [{ label: 'CGST', rate: half, amount: cgst }, { label: 'SGST', rate: half, amount: tax.amount - cgst }] };
}
