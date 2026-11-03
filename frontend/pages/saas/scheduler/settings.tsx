import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import SchedulerNav, { timeZones } from '@/components/SchedulerNav';
import { api } from '@/lib/api';

export default function Settings() {
  return <AppShell><SettingsApp /></AppShell>;
}

const NOTICE = [
  { value: 0, label: 'No notice' }, { value: 30, label: '30 minutes' }, { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' }, { value: 240, label: '4 hours' }, { value: 720, label: '12 hours' },
  { value: 1440, label: '1 day' }, { value: 2880, label: '2 days' }, { value: 10080, label: '1 week' }
];
const STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120];

function SettingsApp() {
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [link, setLink] = useState('');

  const load = async () => {
    try {
      const overview = await api.get('/api/scheduler/overview');
      setData(overview);
      setForm({ ...overview.settings, welcome: overview.settings.welcome || '' });
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (form?.booking_key) setLink(`${window.location.origin}/book/${form.booking_key}`);
  }, [form?.booking_key]);

  const set = (field: string, value: any) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const saved = await api.put('/api/scheduler/settings', form);
      setForm({ ...saved, welcome: saved.welcome || '' });
      setNotice('Saved');
      setError('');
    } catch (err: any) {
      setError(err.message);
      setNotice('');
    }
  };

  const newLink = async () => {
    if (!window.confirm('Make a new booking link? The old link will stop working.')) return;
    try {
      const { booking_key } = await api.post('/api/scheduler/settings/new-key', {});
      setForm({ ...form, booking_key });
      setNotice('New link made');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setNotice('Link copied');
    } catch {
      setNotice('Select the link and copy it');
    }
  };

  if (!form) return <div className="stack"><SchedulerNav />{error ? <p className="error">{error}</p> : <p>Loading…</p>}</div>;
  const manager = data.is_manager;
  const zones = timeZones();

  return (
    <div className="stack">
      <SchedulerNav />
      <div className="page-head"><h1>Scheduler settings</h1></div>
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      <div className="card">
        <h2>Your booking page</h2>
        <p className="muted">Share this link, or put it on your website. Visitors see your services and free times and book without signing in. Each booking adds the visitor to your CRM contacts.</p>
        <div className="booking-link">
          <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Booking link" />
          <button type="button" className="always" onClick={copy}>Copy</button>
          <a className="button" href={link} target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        {manager && <p><button type="button" className="link" onClick={newLink}>Make a new link</button> <span className="muted">if the old one was shared by mistake.</span></p>}
      </div>

      <form className="card" onSubmit={submit}>
        <h2>Booking rules</h2>
        <fieldset disabled={!manager} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="form-grid">
            <label>Time zone
              <select value={form.time_zone} onChange={(e) => set('time_zone', e.target.value)}>
                {!zones.includes(form.time_zone) && <option value={form.time_zone}>{form.time_zone}</option>}
                {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </label>
            <label>Minimum notice
              <select value={form.min_notice_minutes} onChange={(e) => set('min_notice_minutes', Number(e.target.value))}>
                {!NOTICE.some((row) => row.value === form.min_notice_minutes) && <option value={form.min_notice_minutes}>{form.min_notice_minutes} minutes</option>}
                {NOTICE.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
              </select>
            </label>
            <label>Book up to (days ahead)<input type="number" min={1} max={365} value={form.max_days_ahead} onChange={(e) => set('max_days_ahead', e.target.value)} /></label>
            <label>Offer a start time every
              <select value={form.slot_step_minutes} onChange={(e) => set('slot_step_minutes', Number(e.target.value))}>
                {STEPS.map((step) => <option key={step} value={step}>{step} minutes</option>)}
              </select>
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={form.booking_enabled} onChange={(e) => set('booking_enabled', e.target.checked)} /> Booking page is open</label>
          <label style={{ marginTop: 12 }}>Welcome message on the booking page<textarea rows={3} maxLength={1000} value={form.welcome} onChange={(e) => set('welcome', e.target.value)} /></label>
          <p className="muted">Opening hours and booking times all use this time zone. Visitors see times in it too.</p>
          {manager && <div className="form-actions"><button className="primary">Save</button></div>}
        </fieldset>
        {!manager && <p className="muted">Only owners and admins can change these.</p>}
      </form>
    </div>
  );
}
