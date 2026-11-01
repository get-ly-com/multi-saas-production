import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import Modal from '@/components/Modal';
import { api, money } from '@/lib/api';

const blank = { name: '', email: '', phone: '', address: '' };

type Props = { title: string; noun: string; path: string; balanceLabel: string };

export default function PartyList({ title, noun, path, balanceLabel }: Props) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<any>(null);

  const load = async () => {
    try {
      setRows(await api.get(path));
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

  const setActive = async (row: any, is_active: boolean) => {
    try {
      await api.put(`${path}/${row.id}`, { is_active });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>{title}</h1>
        <button className="primary" onClick={() => setForm(blank)}>New {noun}</button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Phone</th><th className="num">{balanceLabel}</th><th /></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="empty">No {noun}s yet</td></tr>}
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="wrap">{row.name}{!row.is_active && <span className="muted"> (inactive)</span>}</td>
                  <td>{row.email || '—'}</td>
                  <td>{row.phone || '—'}</td>
                  <td className="num">{money(row.balance)}</td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setForm({ ...row, email: row.email || '', phone: row.phone || '', address: row.address || '' })}>Edit</button>
                      <button onClick={() => setActive(row, !row.is_active)}>{row.is_active ? 'Deactivate' : 'Reactivate'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {form && <PartyForm initial={form} noun={noun} path={path} onClose={() => setForm(null)} onSaved={load} />}
    </div>
  );
}

function PartyForm({ initial, noun, path, onClose, onSaved }: { initial: any; noun: string; path: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { name, email, phone, address } = form;
    const body = { name, email, phone, address };
    try {
      if (form.id) await api.put(`${path}/${form.id}`, body);
      else await api.post(path, body);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? `Edit ${noun}` : `New ${noun}`}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Email<input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
          <label>Phone<input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        </div>
        <label style={{ marginTop: 12 }}>Address<textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
