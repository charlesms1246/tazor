'use client';

import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { invoiceHash, type Invoice } from '@/lib/invoice.ts';
import { decodeInvoiceLink } from '@/lib/invoice-link.ts';

type State = { status: 'loading' } | { status: 'invalid' } | { status: 'ok'; invoice: Invoice; hash: string };

export default function PayPage() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const load = () =>
      decodeInvoiceLink(location.href)
        .then((invoice) => setState({ status: 'ok', invoice, hash: invoiceHash(invoice) }))
        .catch(() => setState({ status: 'invalid' }));
    load();
    addEventListener('hashchange', load);
    return () => removeEventListener('hashchange', load);
  }, []);

  if (state.status === 'loading') return <main>Decrypting invoice…</main>;
  if (state.status === 'invalid') return <main><h1 data-testid="invalid">Invalid or tampered link</h1></main>;

  const { invoice: i, hash } = state;
  const usdt = (v: bigint) => `${formatUnits(v, 6)} USDT`;
  return (
    <main>
      <h1>Invoice {i.id}</h1>
      <table>
        <tbody>
          <tr><td>From</td><td>{i.supplierName} ({i.supplierAccount})</td></tr>
          <tr><td>Pay to</td><td>{i.payee}</td></tr>
          <tr><td>Buyer account</td><td>{i.buyerAccount}</td></tr>
          <tr><td>Token</td><td>{i.token}</td></tr>
          <tr><td>Amount</td><td data-testid="amount">{usdt(i.amount)}</td></tr>
          <tr><td>Due</td><td>{new Date(i.dueDate * 1000).toISOString().slice(0, 10)}</td></tr>
          <tr><td>Memo</td><td>{i.memo}</td></tr>
          <tr><td>invoiceHash</td><td data-testid="invoice-hash" style={{ wordBreak: 'break-all' }}>{hash}</td></tr>
        </tbody>
      </table>
      <h2>Lines</h2>
      <table>
        <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead>
        <tbody>
          {i.lines.map((l, n) => (
            <tr key={n}><td>{l.description}</td><td>{l.quantity.toString()}</td><td>{usdt(l.unitPrice)}</td><td>{usdt(l.quantity * l.unitPrice)}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
