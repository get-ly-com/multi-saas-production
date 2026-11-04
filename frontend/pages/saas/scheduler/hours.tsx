import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { SkeletonTable } from '@/components/Skeleton';
import Modal from '@/components/Modal';
import SchedulerNav, { WEEKDAYS, dayLabel } from '@/components/SchedulerNav';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Hours() {
  return <AppShell><HoursApp /></AppShell>;
}

// Monday first, as most weeks are planned
const ORDER = [1, 2, 3, 4, 5, 6, 0];

const summary = (hours: any[]) => {
  if (!hours.length) return 'No hours set';
  return ORDER.filter((day) => hours.some((h) => h.weekday === day))
    .map((day) => `${WEEKDAYS[day].slice(0, 3)} ${hours.filter((h) => h.weekday === day).map((h) => `${h.start}–${h.end === '23:59' ? '24:00' : h.end}`).join(', ')}`)
    .join(' · ');
};

function HoursApp() {
  const [data, setData] = useState<any>(null);
  const [daysOff, setDaysOff] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [off, setOff] = useState({ user_id: '', off_date: '', note: '' });
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const overview = await api.get('/api/scheduler/overview');
      const rows = await api.get(`/api/scheduler/days-off?from=${overview.today}`);
      setData(overview);
      setDaysOff(rows);
      setOff((current) => ({ ...current, user_id: current.user_id || (overview.staff.some((row: any) => row.user_id === overview.me && row.set_up) ? overview.me : '') }));
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

  const { busy, run } = useSubmit();
  const addOff = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      act(async () => {
        await api.post('/api/scheduler/days-off', off);
        setOff({ ...off, off_date: '', note: '' });
      });
    });
  };

  if (!data) return <div className="stack"><SchedulerNav />{error ? <p className="error">{error}</p> : <SkeletonTable rows={7} columns={3} />}</div>;

  const team = data.staff.filter((row: any) => row.role !== 'viewer');
  const canEdit = (row: any) => data.can_edit && (data.is_manager || row.user_id === data.me);
  const nameOf = (userId: string | null) => (userId ? data.staff.find((row: any) => row.user_id === userId)?.display_name || 'Former team member' : 'Whole company');
  const offChoices = data.is_manager ? team.filter((row: any) => row.set_up) : team.filter((row: any) => row.set_up && row.user_id === data.me);

  return (
    <div className="stack">
      <SchedulerNav />
      <div className="page-head"><div><h1>Opening hours</h1><p className="muted">When customers can book you, and the days you are closed.</p></div></div>
      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        <h2>Team</h2>
        <table>
          <thead><tr><th>Person</th><th>Weekly hours ({data.settings.time_zone})</th><th>Takes bookings</th><th /></tr></thead>
          <tbody>
            {team.map((row: any) => (
              <tr key={row.user_id}>
                <td>{row.display_name}{row.user_id === data.me ? ' (me)' : ''}<div className="muted">{row.email}</div></td>
                <td className="wrap">{row.set_up ? summary(row.hours) : <span className="muted">Not set up yet</span>}</td>
                <td>{row.set_up ? (row.is_bookable ? 'Yes' : 'No') : '—'}</td>
                <td>{canEdit(row) && <div className="row-actions"><button onClick={() => setEditing(row)}>{row.set_up ? 'Edit' : 'Set up'}</button></div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Everyone sets their own hours; owners and admins can set anyone's. Viewers can't take bookings.</p>
      </div>

      <div className="card table-wrap">
        <h2>Days off</h2>
        {data.can_edit && (
          <form onSubmit={addOff} className="form-grid" style={{ marginBottom: 12, alignItems: 'end' }}>
            <label>Who
              <select value={off.user_id} onChange={(e) => setOff({ ...off, user_id: e.target.value })}>
                {data.is_manager && <option value="">Whole company (closed)</option>}
                {offChoices.map((row: any) => <option key={row.user_id} value={row.user_id}>{row.display_name}</option>)}
              </select>
            </label>
            <label>Date<input type="date" required min={data.today} value={off.off_date} onChange={(e) => setOff({ ...off, off_date: e.target.value })} /></label>
            <label>Note<input maxLength={200} placeholder="Optional" value={off.note} onChange={(e) => setOff({ ...off, note: e.target.value })} /></label>
            <div><button className="primary" disabled={busy || !data.is_manager && !offChoices.length}>Add day off</button></div>
          </form>
        )}
        <table>
          <thead><tr><th>Date</th><th>Who</th><th>Note</th><th /></tr></thead>
          <tbody>
            {daysOff.length === 0 && <tr><td colSpan={4} className="empty">No days off coming up</td></tr>}
            {daysOff.map((row) => (
              <tr key={row.id}>
                <td>{dayLabel(row.off_date, true)}</td>
                <td>{nameOf(row.user_id)}</td>
                <td>{row.note || '—'}</td>
                <td>{data.can_edit && (data.is_manager || row.user_id === data.me) && (
                  <div className="row-actions"><button className="danger" onClick={() => act(() => api.delete(`/api/scheduler/days-off/${row.id}`))}>Remove</button></div>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">No new bookings can be made online on days off. Bookings already made stay; move or cancel them from Bookings.</p>
      </div>

      {editing && <HoursForm person={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function HoursForm({ person, onClose, onSaved }: { person: any; onClose: () => void; onSaved: () => void }) {
  const start = person.set_up
    ? person.hours.map((h: any) => ({ ...h, end: h.end === '23:59' ? '24:00' : h.end }))
    : [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
  const [blocks, setBlocks] = useState<any[]>(start);
  const [name, setName] = useState(person.display_name);
  const [bookable, setBookable] = useState(person.set_up ? person.is_bookable : true);
  const [error, setError] = useState('');

  const change = (index: number, field: string, value: string) =>
    setBlocks(blocks.map((block, i) => (i === index ? { ...block, [field]: value } : block)));

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.put(`/api/scheduler/staff/${person.user_id}`, { display_name: name, is_bookable: bookable, hours: blocks });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Hours for ${person.display_name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name visitors see<input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={bookable} onChange={(e) => setBookable(e.target.checked)} /> Takes bookings</label>
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          {ORDER.map((day) => {
            const rows = blocks.map((block, index) => ({ block, index })).filter(({ block }) => Number(block.weekday) === day);
            return (
              <div key={day} className="hours-day">
                <strong>{WEEKDAYS[day]}</strong>
                <div className="hours-blocks">
                  {rows.length === 0 && <span className="muted">Closed</span>}
                  {rows.map(({ block, index }) => (
                    <div key={index} className="hours-block">
                      <input type="time" aria-label="From" value={block.start} onChange={(e) => change(index, 'start', e.target.value)} />
                      <span>to</span>
                      <input type="time" aria-label="To" value={block.end === '24:00' ? '23:59' : block.end} onChange={(e) => change(index, 'end', e.target.value)} />
                      <button type="button" className="link" onClick={() => setBlocks(blocks.filter((_, i) => i !== index))}>Remove</button>
                    </div>
                  ))}
                </div>
                {rows.length < 4 && (
                  <button type="button" className="link" onClick={() => setBlocks([...blocks, { weekday: day, start: rows.length ? '13:00' : '09:00', end: '17:00' }])}>
                    {rows.length ? 'Add hours' : 'Open'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save hours</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
