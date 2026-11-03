import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { priceText } from '@/components/SchedulerForms';
import SchedulerNav, { LOCATIONS } from '@/components/SchedulerNav';
import { api } from '@/lib/api';

export default function Services() {
  return <AppShell><ServiceList /></AppShell>;
}

const blank = { name: '', description: '', duration_minutes: '30', buffer_minutes: '0', price: '', location_type: 'in_person', location_detail: '', staff_ids: [] as string[] };

function ServiceList() {
  const [data, setData] = useState<any>(null);
  const [services, setServices] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [overview, rows] = await Promise.all([api.get('/api/scheduler/overview'), api.get('/api/scheduler/services')]);
      setData(overview);
      setServices(rows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const act = async (work: () => Promise<any>) => {
    try {
      await work();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const nameOf = (userId: string) => data?.staff.find((row: any) => row.user_id === userId)?.display_name || 'Former team member';

  return (
    <div className="stack">
      <SchedulerNav />
      <div className="page-head">
        <h1>Services</h1>
        {data?.is_manager && <button className="primary" onClick={() => setEditing(blank)}>Add a service</button>}
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Service</th><th className="num">Length</th><th className="num">Buffer</th><th className="num">Price</th><th>Where</th><th>Who offers it</th><th>Status</th><th /></tr></thead>
          <tbody>
            {services.length === 0 && <tr><td colSpan={8} className="empty">No services yet. Add what people can book, like "30 minute consultation".</td></tr>}
            {services.map((row) => (
              <tr key={row.id}>
                <td className="wrap"><strong>{row.name}</strong>{row.description && <div className="muted">{row.description}</div>}</td>
                <td className="num">{row.duration_minutes} min</td>
                <td className="num">{row.buffer_minutes ? `${row.buffer_minutes} min` : '—'}</td>
                <td className="num">{priceText(row.price)}</td>
                <td>{LOCATIONS[row.location_type]}{row.location_detail ? `: ${row.location_detail}` : ''}</td>
                <td className="wrap">{row.staff_ids.length ? row.staff_ids.map(nameOf).join(', ') : 'Anyone who takes bookings'}</td>
                <td><span className={`badge ${row.is_active ? 'paid' : 'void'}`}>{row.is_active ? 'on' : 'off'}</span></td>
                <td>
                  {data?.is_manager && (
                    <div className="row-actions">
                      <button onClick={() => setEditing({ ...row, price: row.price ?? '', duration_minutes: String(row.duration_minutes), buffer_minutes: String(row.buffer_minutes) })}>Edit</button>
                      <button onClick={() => act(() => api.put(`/api/scheduler/services/${row.id}`, { ...row, is_active: !row.is_active }))}>{row.is_active ? 'Turn off' : 'Turn on'}</button>
                      <button className="danger" onClick={() => window.confirm(`Delete ${row.name}?`) && act(() => api.delete(`/api/scheduler/services/${row.id}`))}>Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">The buffer is free time kept after each booking, for travel or tidying up. Only owners and admins can change services.</p>
      </div>

      {editing && data && <ServiceForm initial={editing} staff={data.staff.filter((row: any) => row.set_up)} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function ServiceForm({ initial, staff, onClose, onSaved }: { initial: any; staff: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: any) => setForm({ ...form, [field]: value });
  const toggle = (userId: string) =>
    set('staff_ids', form.staff_ids.includes(userId) ? form.staff_ids.filter((id: string) => id !== userId) : [...form.staff_ids, userId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (form.id) await api.put(`/api/scheduler/services/${form.id}`, form);
      else await api.post('/api/scheduler/services', form);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? `Edit ${initial.name}` : 'Add a service'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required maxLength={100} value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Length (minutes)<input type="number" required min={5} max={480} value={form.duration_minutes} onChange={(e) => set('duration_minutes', e.target.value)} /></label>
          <label>Buffer after (minutes)<input type="number" min={0} max={240} value={form.buffer_minutes} onChange={(e) => set('buffer_minutes', e.target.value)} /></label>
          <label>Price (optional)<input inputMode="decimal" placeholder="Free" value={form.price} onChange={(e) => set('price', e.target.value)} /></label>
          <label>Where
            <select value={form.location_type} onChange={(e) => set('location_type', e.target.value)}>
              {Object.entries(LOCATIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {form.location_type !== 'video' && (
            <label>{form.location_type === 'phone' ? 'Call details (optional)' : 'Address (optional)'}
              <input maxLength={300} value={form.location_detail || ''} onChange={(e) => set('location_detail', e.target.value)} />
            </label>
          )}
        </div>
        {form.location_type === 'video' && <p className="muted">Each booking gets its own Jitsi Meet link. Calls run on Jitsi Meet, a free video service.</p>}
        {form.location_type === 'phone' && <p className="muted">Visitors must leave a phone number.</p>}
        <label style={{ marginTop: 12 }}>Description<textarea rows={2} maxLength={1000} value={form.description || ''} onChange={(e) => set('description', e.target.value)} /></label>
        <div style={{ marginTop: 12 }}>
          <div className="stat-label">Who offers it (none ticked means anyone who takes bookings)</div>
          {staff.length === 0 && <p className="muted">Nobody has set up opening hours yet.</p>}
          {staff.map((row) => (
            <label className="check" key={row.user_id}>
              <input type="checkbox" checked={form.staff_ids.includes(row.user_id)} onChange={() => toggle(row.user_id)} /> {row.display_name}
            </label>
          ))}
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
