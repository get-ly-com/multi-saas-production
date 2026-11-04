import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import { Amount, PageHead, StatusPill, styles } from '@/components/AccountingKit';
import AppShell, { useAccount } from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankAsset = { name: '', cost: '', salvage: '0', life_months: '60', start_date: '', paid_from: '' };

export default function Assets() {
  return <AppShell><AssetsApp /></AppShell>;
}

function AssetsApp() {
  const [assets, setAssets] = useState<any[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [through, setThrough] = useState(today());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const canEdit = useAccount()?.canEdit;
  const [disposing, setDisposing] = useState<any>(null);

  const load = async () => {
    try {
      const [assetRows, accountRows] = await Promise.all([
        api.get('/api/accounting/assets'),
        api.get('/api/accounting/accounts')
      ]);
      setAssets(assetRows);
      setBanks(accountRows.filter((account: any) => account.is_cash && account.is_active));
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
  const depreciate = () => once(async () => {
    try {
      const result = await api.post('/api/accounting/assets/depreciate', { through });
      if (result.months_posted) {
        toast.success('Depreciation posted', { detail: `${result.months_posted} ${result.months_posted === 1 ? 'month' : 'months'} through ${formatDate(through)}` });
      } else {
        toast.info('Nothing new to post', { detail: 'Only finished months are depreciated.' });
      }
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Fixed assets" line={'Straight-line depreciation by month. If you bought the asset on a bill coded to 1500 Fixed Assets, leave "Paid from" empty when you add it.'}>
        <button className="primary" onClick={() => setAdding(true)}>New asset</button>
      </PageHead>

      {error && <p className="error">{error}</p>}

      <div className="card">
        <div className="report-filters">
          <label>Depreciate through<input type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></label>
        </div>
        <div className="form-actions"><button className="primary" disabled={!through} onClick={depreciate}>Run depreciation</button></div>
      </div>

      {loading ? <SkeletonTable rows={4} columns={7} /> : assets.length === 0 ? (
        <div className="card">
          <EmptyState icon="item" title="No fixed assets yet" line="Add equipment, vehicles or furniture, and depreciation posts each month you run it."
            action={canEdit ? { label: 'New asset', onClick: () => setAdding(true) } : undefined} />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Asset</th><th>Start</th><th>Life</th><th className="num">Cost</th><th className="num">Depreciated</th><th className="num">Book value</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id}>
                  <td className="wrap">{asset.name}</td>
                  <td>{formatDate(asset.start_date)}</td>
                  <td>{asset.life_months} months</td>
                  <td className="num"><Amount value={asset.cost} /></td>
                  <td className="num"><Amount value={asset.accumulated} /></td>
                  <td className="num"><Amount value={asset.book_value} strong /></td>
                  <td>{asset.status === 'disposed' ? <StatusPill status="disposed" label={`Disposed ${formatDate(asset.disposed_on)}`} /> : <StatusPill status="active" />}</td>
                  <td>
                    {asset.status === 'active' && (
                      <div className="row-actions"><button className="danger" onClick={() => setDisposing(asset)}>Dispose</button></div>
                    )}
                  </td>
                </tr>
              ))}
              <tr className={styles.totalRow}>
                <td colSpan={3}>Total</td>
                <td className="num"><Amount value={assets.reduce((sum, asset) => sum + Number(asset.cost || 0), 0)} /></td>
                <td className="num"><Amount value={assets.reduce((sum, asset) => sum + Number(asset.accumulated || 0), 0)} /></td>
                <td className="num"><Amount value={assets.reduce((sum, asset) => sum + Number(asset.book_value || 0), 0)} strong /></td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {adding && <AssetForm banks={banks} onClose={() => setAdding(false)} onSaved={load} />}
      {disposing && <DisposeForm asset={disposing} banks={banks} onClose={() => setDisposing(null)} onSaved={async () => { toast.success('Asset disposed', { detail: `${disposing.name} is off the books and the gain or loss is posted` }); await load(); }} />}
    </div>
  );
}

function AssetForm({ banks, onClose, onSaved }: { banks: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ ...blankAsset, start_date: today() });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/assets', form);
        await onSaved();
        toast.success('Asset added', { detail: `${form.name} depreciates over ${form.life_months} months` });
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="New fixed asset" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Cost<input required type="number" min="0.01" step="0.01" value={form.cost} onChange={(e) => set('cost', e.target.value)} /></label>
          <label>Salvage value<input type="number" min="0" step="0.01" value={form.salvage} onChange={(e) => set('salvage', e.target.value)} /></label>
          <label>Useful life (months)<input required type="number" min="1" step="1" value={form.life_months} onChange={(e) => set('life_months', e.target.value)} /></label>
          <label>In use from<input required type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} /></label>
          <label>Paid from
            <select value={form.paid_from} onChange={(e) => set('paid_from', e.target.value)}>
              <option value="">Already recorded on a bill</option>
              {banks.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
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

function DisposeForm({ asset, banks, onClose, onSaved }: { asset: any; banks: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ disposed_on: today(), proceeds: '0', account_id: banks[0]?.id || '' });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post(`/api/accounting/assets/${asset.id}/dispose`, form);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Dispose of ${asset.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Book value {money(asset.book_value)}. Run depreciation first if any finished months are missing. The gain or loss posts automatically.</p>
        <div className="form-grid">
          <label>Date<input required type="date" value={form.disposed_on} onChange={(e) => set('disposed_on', e.target.value)} /></label>
          <label>Sold for<input type="number" min="0" step="0.01" value={form.proceeds} onChange={(e) => set('proceeds', e.target.value)} /></label>
          <label>Received in
            <select value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
              {banks.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Dispose</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
