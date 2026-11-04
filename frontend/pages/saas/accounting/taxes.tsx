import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import { PageHead, StatusPill } from '@/components/AccountingKit';
import AppShell, { useAccount } from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Taxes() {
  return <AppShell><TaxesApp /></AppShell>;
}

function TaxesApp() {
  const [rates, setRates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const canEdit = useAccount()?.canEdit;

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
      toast.success(is_active ? 'Tax rate active again' : 'Tax rate deactivated', {
        detail: `${rate.name} (${Number(rate.rate)}%)`,
        action: { label: 'Undo', onClick: () => { setActive(rate, !is_active); } }
      });
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Tax rates" line="A rate can't be edited once created, so past invoices stay correct. When a rate changes, deactivate it and add a new one.">
        <button className="primary" onClick={() => setAdding(true)}>New tax rate</button>
      </PageHead>

      {error && <p className="error">{error}</p>}

      {loading ? <SkeletonTable rows={3} columns={4} /> : rates.length === 0 ? (
        <div className="card">
          <EmptyState icon="invoice" title="No tax rates yet" line="Add the sales tax or VAT you charge, and it shows up on every invoice line."
            action={canEdit ? { label: 'New tax rate', onClick: () => setAdding(true) } : undefined} />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Name</th><th className="num">Rate</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rates.map((rate) => (
                <tr key={rate.id}>
                  <td className="wrap">{rate.name}</td>
                  <td className="num">{Number(rate.rate)}%</td>
                  <td><StatusPill status={rate.is_active ? 'active' : 'inactive'} /></td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setActive(rate, !rate.is_active)}>{rate.is_active ? 'Deactivate' : 'Activate'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && <RateForm onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}

function RateForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', rate: '' });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/tax-rates', form);
        await onSaved();
        toast.success('Tax rate added', { detail: `${form.name} at ${Number(form.rate)}% is ready to use` });
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="New tax rate" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Rate (%)<input required type="number" min="0" max="100" step="0.001" value={form.rate} onChange={(e) => set('rate', e.target.value)} /></label>
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
