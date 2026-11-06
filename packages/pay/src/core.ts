// @tazor/pay core: payment links in exactly the Tazor app's format, and payment detection from Whitechain logs.
// The invoice, link and tax code is the app's own (apps/web/lib), so a link made here is the link the app makes.
import { decodeEventLog, formatUnits, getAddress, parseAbi, toHex, type Address, type Hex } from 'viem';
import { invoiceHash as hashInvoice, type Invoice } from '../../../apps/web/lib/invoice.ts';
import { decodeInvoiceLink, encodeInvoiceLink } from '../../../apps/web/lib/invoice-link.ts';
import { buildInvoice, newInvoiceId, parseRate, withTax, type InvoiceForm } from '../../../apps/web/lib/invoices-store.ts';

export { decodeInvoiceLink, type Invoice };

export const DEFAULT_APP_URL = 'https://tazor.charlesms.dev';
export const DEFAULT_EXPLORER = 'https://explorer.testnet.whitechain.io';
/** PaymentModule v1 and v2 on Whitechain Sepolia: both emit InvoicePaid(account, nonce = invoice hash, payee, amount, viaL1). */
export const PAYMENT_MODULES: Address[] = ['0xe19ddf1fd417B146137A5dE6eb56c4589431540A', '0x906620D82e2959351c81D731C67EA46DF71E36f3'];

export type LineInput = { description: string; quantity?: number | string; unitPrice: string };
export type InvoiceInput = {
  supplierName: string;
  /** The supplier's Tazor account; defaults to the payee. */
  supplierAccount?: string;
  /** Where the USDT goes. */
  payee: string;
  /** The customer's Tazor company account (it approves and pays). */
  buyerAccount: string;
  /** Unit prices in USDT as decimal strings, e.g. '12.50' (up to 6 decimals). */
  lines: LineInput[];
  /** Optional tax, added as a final line "<taxLabel> <taxRate>%" exactly like the app does. */
  taxRate?: number | string;
  taxLabel?: string;
  /** The due day: 'YYYY-MM-DD', a Date, or unix seconds. */
  dueDate: string | Date | number;
  memo?: string;
  /** Your order or invoice number; a fixed id gives a stable invoiceHash for the same order. Defaults to INV-YYYYMMDD-XXXX. */
  id?: string;
  /** The Tazor app that opens the link. */
  appUrl?: string;
};
export type InvoiceLink = { id: string; url: string; invoiceHash: Hex; amount: string; amountBaseUnits: bigint; invoice: Invoice };

const day = (d: string | Date | number): string => {
  if (typeof d === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('dueDate must be YYYY-MM-DD, a Date or unix seconds');
    return d;
  }
  const date = typeof d === 'number' ? new Date(d * 1000) : d;
  if (Number.isNaN(date.getTime())) throw new Error('dueDate is not a valid date');
  return date.toISOString().slice(0, 10);
};

/** The invoice a link would carry, validated exactly as the Tazor app validates its own invoices. */
export function buildTazorInvoice(input: InvoiceInput): Invoice {
  const form: InvoiceForm = {
    customer: input.buyerAccount, payee: input.payee, supplierName: input.supplierName,
    supplierAccount: input.supplierAccount ?? '', dueDate: day(input.dueDate), memo: input.memo ?? '',
    lines: input.lines.map((l) => ({ description: l.description, quantity: String(l.quantity ?? 1), unitPrice: l.unitPrice })),
  };
  const rate = input.taxRate === undefined || input.taxRate === '' ? '' : String(input.taxRate);
  if (rate && parseRate(rate) === null) throw new Error('taxRate must be a number from 0 to 100 with up to 2 decimals');
  const r = buildInvoice(withTax(form, rate, input.taxLabel ?? 'Tax'), input.id ?? newInvoiceId());
  if ('error' in r) throw new Error(r.error);
  return r.invoice;
}

/** Creates an encrypted payment link (…/pay/#v1.…) that the Tazor app opens, approves with a passkey and pays. */
export async function createInvoiceLink(input: InvoiceInput): Promise<InvoiceLink> {
  const invoice = buildTazorInvoice(input);
  const url = await encodeInvoiceLink(invoice, input.appUrl ?? DEFAULT_APP_URL);
  return { id: invoice.id, url, invoiceHash: hashInvoice(invoice), amount: formatUnits(invoice.amount, 6), amountBaseUnits: invoice.amount, invoice };
}

/** keccak256 of the canonical invoice JSON: the nonce PaymentModule emits when the invoice is paid. */
export const invoiceHash = (invoice: Invoice): Hex => hashInvoice(invoice);

// ---- payment detection

const invoicePaid = parseAbi(['event InvoicePaid(address indexed account, uint256 indexed nonce, address payee, uint256 amount, bool viaL1)']);

/** One log as returned by Blockscout v2 /api/v2/addresses/<contract>/logs (only the fields used). */
export type ExplorerLog = { block_timestamp: string; data: Hex; topics: (Hex | null)[]; transaction_hash: Hex };
export type Payment = {
  txHash: Hex;
  /** USDT as a decimal string, e.g. '1.55'. */
  amount: string;
  amountBaseUnits: bigint;
  /** Block time, ms since epoch. */
  at: number;
  payer: Address;
  payee: Address;
  viaL1: boolean;
};

/** Finds the InvoicePaid for an invoice hash (and payee, if given) among explorer logs. */
export function findPayment(logs: ExplorerLog[], invoiceHash: Hex, payee?: string): Payment | null {
  const want = toHex(BigInt(invoiceHash), { size: 32 });
  for (const log of logs) {
    const topics = log.topics.filter((t): t is Hex => !!t);
    if (topics.length < 3 || topics[2].toLowerCase() !== want) continue;
    try {
      const ev = decodeEventLog({ abi: invoicePaid, data: log.data, topics: topics as [Hex, ...Hex[]] });
      if (payee && getAddress(payee) !== ev.args.payee) continue;
      return {
        txHash: log.transaction_hash, amount: formatUnits(ev.args.amount, 6), amountBaseUnits: ev.args.amount,
        at: Date.parse(log.block_timestamp), payer: ev.args.account, payee: ev.args.payee, viaL1: ev.args.viaL1,
      };
    } catch {
      // another event with three topics
    }
  }
  return null;
}

export type LookupOptions = { explorer?: string; contracts?: Address[]; fetch?: typeof fetch; payee?: string };

/** Reads the newest logs of both PaymentModules and returns the payment for this invoice, or null. */
export async function getPayment(invoiceHash: Hex, opts: LookupOptions = {}): Promise<Payment | null> {
  const f = opts.fetch ?? fetch;
  const api = `${(opts.explorer ?? DEFAULT_EXPLORER).replace(/\/+$/, '')}/api/v2`;
  const batches = await Promise.all((opts.contracts ?? PAYMENT_MODULES).map(async (c) => {
    const res = await f(`${api}/addresses/${c}/logs`);
    if (!res.ok) throw new Error(`explorer returned ${res.status}`);
    return ((await res.json()) as { items?: ExplorerLog[] }).items ?? [];
  }));
  return findPayment(batches.flat(), invoiceHash, opts.payee);
}

/** True once the invoice is paid on Whitechain. */
export const isPaid = async (invoiceHash: Hex, opts: LookupOptions = {}): Promise<boolean> => (await getPayment(invoiceHash, opts)) !== null;

export type WatchOptions = LookupOptions & {
  invoiceHash: Hex;
  onPaid: (p: Payment & { invoiceHash: Hex; explorerUrl: string }) => void;
  onError?: (e: Error) => void;
  intervalMs?: number;
};

/** Polls until the invoice is paid, calls onPaid once, then stops. Returns stop(). */
export function watchPayment(opts: WatchOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const explorer = (opts.explorer ?? DEFAULT_EXPLORER).replace(/\/+$/, '');
  const poll = async () => {
    if (stopped) return;
    try {
      const p = await getPayment(opts.invoiceHash, opts);
      if (p && !stopped) {
        stopped = true;
        opts.onPaid({ ...p, invoiceHash: opts.invoiceHash, explorerUrl: `${explorer}/tx/${p.txHash}` });
        return;
      }
    } catch (e) {
      opts.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
    if (!stopped) timer = setTimeout(poll, opts.intervalMs ?? 4000);
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
