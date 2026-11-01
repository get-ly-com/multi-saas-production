import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';

export default function Taxes() {
  return <AppShell><TaxesApp /></AppShell>;
}

function TaxesApp() {
  const [rates, setRates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      setRates(await api.get('/api/accounting/tax-rates'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const setActive = async (rate: any, is_active: boolean) => {
    try {
      await api.put(`/api/accounting/tax-rates/${rate.id}`, { is_active });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Tax rates</h1>
        <button className="primary" onClick={() => setAdding(true)}>New tax rate</button>
      </div>

      <p className="muted">A rate can't be edited once created, so past invoices stay correct. When a rate changes, deactivate it and add a new one.</p>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Name</th><th className="num">Rate</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rates.length === 0 && <tr><td colSpan={4} className="empty">No tax rates yet</td></tr>}
              {rates.map((rate) => (
                <tr key={rate.id}>
                  <td className="wrap">{rate.name}</td>
                  <td className="num">{Number(rate.rate)}%</td>
                  <td><span className="badge">{rate.is_active ? 'active' : 'inactive'}</span></td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setActive(rate, !rate.is_active)}>{rate.is_active ? 'Deactivate' : 'Activate'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding && <RateForm onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}

function RateForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', rate: '' });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/accounting/tax-rates', form);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title="New tax rate">
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Rate (%)<input required type="number" min="0" max="100" step="0.001" value={form.rate} onChange={(e) => set('rate', e.target.value)} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
