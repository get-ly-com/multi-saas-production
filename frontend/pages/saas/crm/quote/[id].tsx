import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import QuoteForm from '@/components/QuoteForm';
import { api, formatDate, money } from '@/lib/api';
import { quoteBadge, quoteLabel } from '../quotes';

export default function Quote() {
  return <AppShell><QuoteApp /></AppShell>;
}

function QuoteApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [quote, setQuote] = useState<any>(null);
  const [invoice, setInvoice] = useState<any>(null);
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = async () => {
    try {
      const [row, me] = await Promise.all([api.get(`/api/crm/quotes/${id}`), api.get('/api/me')]);
      const linked = row.invoice_id ? await api.get(`/api/accounting/invoices/${row.invoice_id}`) : null;
      setQuote(row);
      setInvoice(linked);
      setCompany(me.tenant.name);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (id) load();
  }, [id]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const setStatus = (status: string) => run(() => api.post(`/api/crm/quotes/${id}/status`, { status }));

  const accept = () => {
    const question = `Accept ${quote.quote_number}? ${quote.deal ? 'Its deal is marked won and a' : 'A'} draft invoice is created in Accounting.`;
    if (window.confirm(question)) run(() => api.post(`/api/crm/quotes/${id}/accept`, {}));
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${quote.quote_number}? This can't be undone.`)) return;
    try {
      await api.delete(`/api/crm/quotes/${id}`);
      router.push('/saas/crm/quotes');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const label = quote ? quoteLabel(quote) : '';

  return (
    <div className="stack">
      <div className="no-print"><CrmNav /></div>
      {error && <p className="error no-print">{error}</p>}
      {quote && (
        <>
          <div className="page-head no-print">
            <div>
              <h1>{quote.quote_number} <span className={`badge ${quoteBadge(label)}`}>{label}</span></h1>
              {quote.deal && <p className="muted">Deal: <Link href={`/saas/crm/deal/${quote.deal.id}`}>{quote.deal.title}</Link></p>}
            </div>
            <div className="row-actions">
              {quote.status === 'draft' && (
                <>
                  <button className="primary" onClick={() => setStatus('sent')}>Mark sent</button>
                  <button onClick={() => setEditing(true)}>Edit</button>
                  <button className="danger" onClick={remove}>Delete</button>
                </>
              )}
              {quote.status === 'sent' && (
                <>
                  <button className="primary" onClick={accept}>Accept</button>
                  <button onClick={() => setStatus('declined')}>Decline</button>
                </>
              )}
              {['sent', 'declined'].includes(quote.status) && <button onClick={() => setStatus('draft')}>Back to draft</button>}
              <button className="primary always" onClick={() => window.print()}>Print or save as PDF</button>
            </div>
          </div>

          {quote.status === 'accepted' && (
            <div className="card no-print">
              {invoice && invoice.status !== 'void' ? (
                <p>
                  Invoice <Link href={`/saas/accounting/invoice/${invoice.id}`}>{invoice.invoice_number}</Link> is <span className={`badge ${invoice.status}`}>{invoice.status}</span>
                  {invoice.status === 'draft' && ' Stock leaves when Accounting marks it sent.'}
                </p>
              ) : (
                <>
                  <p>{invoice ? `Invoice ${invoice.invoice_number} was voided.` : 'The draft invoice was deleted.'}</p>
                  <button className="primary" onClick={() => run(() => api.post(`/api/crm/quotes/${id}/invoice`, {}))}>Create invoice again</button>
                </>
              )}
            </div>
          )}

          <div className="card document">
            <div className="document-head">
              <div>
                <h1>{company}</h1>
                <p className="muted">Quote</p>
              </div>
              <div className="document-meta">
                <div><strong>{quote.quote_number}</strong></div>
                <div>Date {formatDate(quote.issue_date)}</div>
                {quote.valid_until && <div>Valid until {formatDate(quote.valid_until)}</div>}
              </div>
            </div>

            <div>
              <div className="muted">For</div>
              {quote.company && <div>{quote.company.name}</div>}
              {quote.contact && <div>{quote.contact.name}</div>}
              {quote.contact?.email && <div>{quote.contact.email}</div>}
            </div>

            <div className="table-wrap">
              <table>
                <thead><tr><th>Description</th><th className="num">Quantity</th><th className="num">Price</th><th className="num">Discount</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {quote.line_items.map((line: any, index: number) => (
                    <tr key={index}>
                      <td className="wrap">{line.description}</td>
                      <td className="num">{Number(line.quantity)}</td>
                      <td className="num">{money(line.unit_price)}</td>
                      <td className="num">{Number(line.discount) ? `${Number(line.discount)}%` : '—'}</td>
                      <td className="num">{money(line.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="document-totals">
              <div><span>Subtotal</span><span>{money(quote.subtotal)}</span></div>
              <div><span>Tax</span><span>{money(quote.tax_amount)}</span></div>
              <div className="due"><span>Total</span><span>{money(quote.total)}</span></div>
            </div>

            <p className="muted">Payment due {quote.due_days} days after invoice.</p>
            {quote.notes && <p className="wrap">{quote.notes}</p>}
          </div>

          {editing && <QuoteForm initial={{ ...quote, valid_until: quote.valid_until || '', deal_id: quote.deal_id || '', contact_id: quote.contact_id || '', company_id: quote.company_id || '' }} onClose={() => setEditing(false)} onSaved={load} />}
        </>
      )}
    </div>
  );
}
