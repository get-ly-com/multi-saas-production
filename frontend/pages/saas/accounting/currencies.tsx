import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import { api, formatDate, setBaseCurrency, today } from '@/lib/api';

export default function Currencies() {
  return <AppShell><CurrenciesApp /></AppShell>;
}

function CurrenciesApp() {
  const [overview, setOverview] = useState<any>(null);
  const [form, setForm] = useState({ currency: '', rate_date: today(), rate: '' });
  const [base, setBase] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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

  const saveRate = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/accounting/currencies/rates', form);
      setNotice(`Saved the ${form.currency.toUpperCase()} rate.`);
      setForm({ ...form, currency: '', rate: '' });
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  };

  const saveBase = async () => {
    try {
      await api.put('/api/accounting/currencies/base', { currency: base });
      setBaseCurrency(base.toUpperCase());
      setNotice(`Base currency set to ${base.toUpperCase()}.`);
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  };

  if (!overview) return error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>;

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head"><h1>Currencies</h1></div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        <h2>Base currency: {overview.base}</h2>
        <p className="muted">The ledger and every report are kept in this currency. It can only be set before anything is recorded.</p>
        {overview.can_change_base && (
          <>
            <div className="report-filters">
              <label>Currency code<input maxLength={3} value={base} onChange={(e) => setBase(e.target.value.toUpperCase())} /></label>
            </div>
            <div className="form-actions"><button className="primary" onClick={saveBase}>Set base currency</button></div>
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
          <div className="form-actions"><button className="primary">Save rate</button></div>
        </form>
      </div>

      <div className="card table-wrap">
        <h2>Latest rates</h2>
        <table>
          <thead><tr><th>Currency</th><th>Date</th><th className="num">1 unit in {overview.base}</th></tr></thead>
          <tbody>
            {overview.rates.length === 0 && <tr><td colSpan={3} className="empty">No exchange rates yet</td></tr>}
            {overview.rates.map((row: any) => (
              <tr key={row.currency}>
                <td>{row.currency}</td>
                <td>{formatDate(row.rate_date)}</td>
                <td className="num">{Number(row.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
