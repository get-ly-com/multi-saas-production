import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import { PageHead } from '@/components/AccountingKit';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, setBaseCurrency, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Currencies() {
  return <AppShell><CurrenciesApp /></AppShell>;
}

function CurrenciesApp() {
  const [overview, setOverview] = useState<any>(null);
  const [form, setForm] = useState({ currency: '', rate_date: today(), rate: '' });
  const [base, setBase] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await api.get('/api/accounting/currencies');
      setOverview(data);
      setBase(data.base);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run } = useSubmit();
  const saveRate = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/currencies/rates', form);
        toast.success('Rate saved', { detail: `1 ${form.currency.toUpperCase()} is ${Number(form.rate)} ${overview?.base || ''} from ${formatDate(form.rate_date)}` });
        setForm({ ...form, currency: '', rate: '' });
        await load();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const saveBase = () => run(async () => {
    try {
      await api.put('/api/accounting/currencies/base', { currency: base });
      setBaseCurrency(base.toUpperCase());
      toast.success('Base currency set', { detail: `Your books and reports are now kept in ${base.toUpperCase()}` });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  if (!overview) {
    return error ? <p className="error">{error}</p> : (
      <div className="stack" role="status" aria-label="Loading">
        <AccountingNav />
        <Skeleton width={180} height={26} />
        <div className="card"><Skeleton width="40%" height={18} /><Skeleton width="80%" style={{ marginTop: 10 }} /></div>
        <SkeletonTable rows={3} columns={3} />
      </div>
    );
  }

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Currencies" line="Invoice and pay in other currencies. Rates turn them into your base currency." />

      {error && <p className="error">{error}</p>}

      <div className="card">
        <h2>Base currency: {overview.base}</h2>
        <p className="muted">The ledger and every report are kept in this currency. It can only be set before anything is recorded.</p>
        {overview.can_change_base && (
          <>
            <div className="report-filters">
              <label>Currency code<input maxLength={3} value={base} onChange={(e) => setBase(e.target.value.toUpperCase())} /></label>
            </div>
            <div className="form-actions"><button disabled={busy} className="primary" onClick={saveBase}>Set base currency</button></div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Add an exchange rate</h2>
        <form onSubmit={saveRate}>
          <div className="form-grid">
            <label>Currency code<input required maxLength={3} placeholder="EUR" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></label>
            <label>Date<input required type="date" value={form.rate_date} onChange={(e) => setForm({ ...form, rate_date: e.target.value })} /></label>
            <label>1 unit in {overview.base}<input required type="number" min="0.00000001" step="any" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></label>
          </div>
          <div className="form-actions"><button disabled={busy} className="primary">Save rate</button></div>
        </form>
      </div>

      <div className="card table-wrap">
        <h2>Latest rates</h2>
        {overview.rates.length === 0 ? (
          <EmptyState compact icon="money" title="No exchange rates yet" line="Add a rate above before you invoice or pay in another currency." />
        ) : (
        <table>
          <thead><tr><th>Currency</th><th>Date</th><th className="num">1 unit in {overview.base}</th></tr></thead>
          <tbody>
            {overview.rates.map((row: any) => (
              <tr key={row.currency}>
                <td>{row.currency}</td>
                <td>{formatDate(row.rate_date)}</td>
                <td className="num">{Number(row.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>
    </div>
  );
}
