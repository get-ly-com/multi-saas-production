import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import EmptyState from '@/components/EmptyState';
import QuoteForm from '@/components/QuoteForm';
import { SkeletonTable } from '@/components/Skeleton';
import { api, formatDate, money, today } from '@/lib/api';

export const quoteLabel = (quote: any) =>
  (quote.status === 'sent' && quote.valid_until && quote.valid_until < today() ? 'expired' : quote.status);

export const quoteBadge = (label: string) =>
  (label === 'accepted' ? 'paid' : label === 'sent' ? 'sent' : label === 'declined' || label === 'expired' ? 'void' : '');

export default function Quotes() {
  return <AppShell><QuotesApp /></AppShell>;
}

function QuotesApp() {
  const router = useRouter();
  const [quotes, setQuotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.get('/api/crm/quotes')
      .then(setQuotes)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Quotes</h1>
        <button className="primary" onClick={() => setAdding(true)}>New quote</button>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? <SkeletonTable rows={6} columns={6} /> : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Quote</th><th>For</th><th>Deal</th><th>Date</th><th>Status</th><th className="num">Total</th></tr></thead>
            <tbody>
              {quotes.length === 0 && (
                <tr><td colSpan={6}><EmptyState compact icon="quote" title="No quotes yet" line="Send a clear, priced quote and turn it into an invoice when it's accepted."
                  action={{ label: 'New quote', onClick: () => setAdding(true) }} /></td></tr>
              )}
              {quotes.map((quote) => (
                <tr key={quote.id}>
                  <td><Link href={`/saas/crm/quote/${quote.id}`}>{quote.quote_number}</Link></td>
                  <td className="wrap">{quote.company?.name || quote.contact?.name || '—'}</td>
                  <td className="wrap">{quote.deal ? <Link href={`/saas/crm/deal/${quote.deal.id}`}>{quote.deal.title}</Link> : '—'}</td>
                  <td>{formatDate(quote.issue_date)}</td>
                  <td><span className={`badge ${quoteBadge(quoteLabel(quote))}`}>{quoteLabel(quote)}</span></td>
                  <td className="num">{money(quote.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && <QuoteForm onClose={() => setAdding(false)} onSaved={(id) => { router.push(`/saas/crm/quote/${id}`); }} />}
    </div>
  );
}
