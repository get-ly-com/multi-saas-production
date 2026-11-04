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

export default function CostCenters() {
  return <AppShell><CostCentersApp /></AppShell>;
}

function CostCentersApp() {
  const [centers, setCenters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const canEdit = useAccount()?.canEdit;

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
  const setActive = (center: any, is_active: boolean): Promise<void> => once(async () => {
    try {
      await api.put(`/api/accounting/cost-centers/${center.id}`, { is_active });
      await load();
      toast.success(is_active ? 'Cost center active again' : 'Cost center deactivated', {
        detail: `${center.code} ${center.name}`,
        action: { label: 'Undo', onClick: () => { setActive(center, !is_active); } }
      });
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Cost centers" line="Tag invoices, bills, expenses and journal lines by branch or department, then see profit for each under Reports.">
        <button className="primary" onClick={() => setAdding(true)}>New cost center</button>
      </PageHead>

      {error && <p className="error">{error}</p>}

      {loading ? <SkeletonTable rows={4} columns={4} /> : centers.length === 0 ? (
        <div className="card">
          <EmptyState icon="company" title="No cost centers yet" line="Add one for each branch or department you want to see profit for."
            action={canEdit ? { label: 'New cost center', onClick: () => setAdding(true) } : undefined} />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Status</th><th /></tr></thead>
            <tbody>
              {centers.map((center) => (
                <tr key={center.id}>
                  <td>{center.code}</td>
                  <td className="wrap">{center.name}</td>
                  <td><StatusPill status={center.is_active ? 'active' : 'inactive'} /></td>
                  <td>
                    <div className="row-actions">
                      <button disabled={busy} onClick={() => setActive(center, !center.is_active)}>{center.is_active ? 'Deactivate' : 'Activate'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
        toast.success('Cost center added', { detail: `${form.code} ${form.name} is ready to tag` });
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
