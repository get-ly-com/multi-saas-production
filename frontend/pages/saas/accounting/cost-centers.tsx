import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function CostCenters() {
  return <AppShell><CostCentersApp /></AppShell>;
}

function CostCentersApp() {
  const [centers, setCenters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      setCenters(await api.get('/api/accounting/cost-centers'));
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

  const { busy, run: once } = useSubmit();
  const setActive = (center: any, is_active: boolean) => once(async () => {
    try {
      await api.put(`/api/accounting/cost-centers/${center.id}`, { is_active });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Cost centers</h1>
        <button className="primary" onClick={() => setAdding(true)}>New cost center</button>
      </div>

      <p className="muted">Tag invoices, bills, expenses and journal lines by branch or department, then see profit for each under Reports.</p>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Status</th><th /></tr></thead>
            <tbody>
              {centers.length === 0 && <tr><td colSpan={4} className="empty">No cost centers yet</td></tr>}
              {centers.map((center) => (
                <tr key={center.id}>
                  <td>{center.code}</td>
                  <td className="wrap">{center.name}</td>
                  <td><span className="badge">{center.is_active ? 'active' : 'inactive'}</span></td>
                  <td>
                    <div className="row-actions">
                      <button disabled={busy} onClick={() => setActive(center, !center.is_active)}>{center.is_active ? 'Deactivate' : 'Activate'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding && <CenterForm onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}

function CenterForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ code: '', name: '' });
  const [error, setError] = useState('');

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/cost-centers', form);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="New cost center" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Code<input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
