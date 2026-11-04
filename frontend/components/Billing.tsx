import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Amount, StatusPill, shownStatus } from '@/components/AccountingKit';
import { api, formatDate, money } from '@/lib/api';

// What Accounting has billed this customer, shown inside the CRM
export default function Billing({ query }: { query: string }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api.get(`/api/crm/billing?${query}`).then(setData).catch(() => setData(null));
  }, [query]);

  if (!data || data.invoices.length === 0) return null;

  return (
    <div className="card table-wrap">
      <h2>Billing</h2>
      <p className="muted">Invoiced {money(data.invoiced)} · Still owed {money(data.outstanding)}</p>
      <table>
        <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
        <tbody>
          {data.invoices.map((invoice: any) => (
            <tr key={invoice.id}>
              <td><Link href={`/saas/accounting/invoice/${invoice.id}`}>{invoice.invoice_number}</Link></td>
              <td>{formatDate(invoice.invoice_date)}</td>
              <td><StatusPill status={shownStatus(invoice)} /></td>
              <td className="num"><Amount value={invoice.amount} currency={invoice.currency} /></td>
              <td className="num"><Amount value={invoice.balance} currency={invoice.currency} dim={Number(invoice.balance) === 0} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
