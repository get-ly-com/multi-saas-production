import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';

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
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
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

  const depreciate = async () => {
    try {
      const result = await api.post('/api/accounting/assets/depreciate', { through });
      setNotice(result.months_posted ? `Posted depreciation for ${result.months_posted} month(s).` : 'Nothing new to post. Only finished months are depreciated.');
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Fixed assets</h1>
        <button className="primary" onClick={() => setAdding(true)}>New asset</button>
      </div>

      <p className="muted">Straight-line depreciation by month. If the asset was bought on a bill coded to 1500 Fixed Assets, leave "Paid from" empty when registering it.</p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        <div className="report-filters">
          <label>Depreciate through<input type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></label>
        </div>
        <div className="form-actions"><button className="primary" disabled={!through} onClick={depreciate}>Run depreciation</button></div>
      </div>

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead>
              <tr><th>Asset</th><th>Start</th><th>Life</th><th className="num">Cost</th><th className="num">Depreciated</th><th className="num">Book value</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {assets.length === 0 && <tr><td colSpan={8} className="empty">No fixed assets yet</td></tr>}
              {assets.map((asset) => (
                <tr key={asset.id}>
                  <td className="wrap">{asset.name}</td>
                  <td>{formatDate(asset.start_date)}</td>
                  <td>{asset.life_months} months</td>
                  <td className="num">{money(asset.cost)}</td>
                  <td className="num">{money(asset.accumulated)}</td>
                  <td className="num">{money(asset.book_value)}</td>
                  <td><span className="badge">{asset.status === 'disposed' ? `disposed ${formatDate(asset.disposed_on)}` : 'active'}</span></td>
                  <td>
                    {asset.status === 'active' && (
                      <div className="row-actions"><button className="danger" onClick={() => setDisposing(asset)}>Dispose</button></div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding && <AssetForm banks={banks} onClose={() => setAdding(false)} onSaved={load} />}
      {disposing && <DisposeForm asset={disposing} banks={banks} onClose={() => setDisposing(null)} onSaved={async () => { setNotice(`${disposing.name} disposed.`); await load(); }} />}
    </div>
  );
}

function AssetForm({ banks, onClose, onSaved }: { banks: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ ...blankAsset, start_date: today() });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/accounting/assets', form);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title="New fixed asset">
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
          <button className="primary">Save</button>
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post(`/api/accounting/assets/${asset.id}/dispose`, form);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Dispose of ${asset.name}`}>
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
          <button className="primary">Dispose</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
