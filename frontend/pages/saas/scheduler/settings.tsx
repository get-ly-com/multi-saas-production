import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { toast } from '@/components/Toast';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import SchedulerNav, { timeZones } from '@/components/SchedulerNav';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

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
  // Saves and copies finish in place, so they say so with a toast
  const setNotice = (text: string) => { if (text) (/^Select/.test(text) ? toast.info(text) : toast.success(text)); };
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

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        const saved = await api.put('/api/scheduler/settings', form);
        setForm({ ...saved, welcome: saved.welcome || '' });
        setNotice('Saved');
        setError('');
      } catch (err: any) {
        setError(err.message);
        setNotice('');
      }
    });
  };

  const newLink = () => run(async () => {
    if (!window.confirm('Make a new booking link? The old link will stop working.')) return;
    try {
      const { booking_key } = await api.post('/api/scheduler/settings/new-key', {});
      setForm({ ...form, booking_key });
      setNotice('New link made');
    } catch (err: any) {
      setError(err.message);
    }
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setNotice('Link copied');
    } catch {
      setNotice('Select the link and copy it');
    }
  };

  if (!form) return <div className="stack"><SchedulerNav />{error ? <p className="error">{error}</p> : <SkeletonTable rows={5} columns={2} />}</div>;
  const manager = data.is_manager;
  const zones = timeZones();

  return (
    <div className="stack">
      <SchedulerNav />
      <div className="page-head"><div><h1>Scheduler settings</h1><p className="muted">Your booking page, notice times and calendar links.</p></div></div>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <h2>Your booking page</h2>
        <p className="muted">Share this link, or put it on your website. Visitors see your services and free times and book without signing in. Each booking adds the visitor to your CRM contacts.</p>
        <div className="booking-link">
          <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Booking link" />
          <button type="button" className="always" onClick={copy}>Copy</button>
          <a className="button" href={link} target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        {manager && <p><button disabled={busy} type="button" className="link" onClick={newLink}>Make a new link</button> <span className="muted">if the old one was shared by mistake.</span></p>}
      </div>

      <CalendarFeed canEdit={data.can_edit} onNotice={setNotice} onError={setError} />

      <BusyCalendar canEdit={data.can_edit} onNotice={setNotice} onError={setError} />

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
          <label className="check"><input type="checkbox" checked={form.draft_invoices !== false} onChange={(e) => set('draft_invoices', e.target.checked)} /> Create a draft invoice for paid bookings</label>
          <p className="muted">The draft goes to Accounting for the customer's CRM contact, at the service price. Nothing is sent until you send it. If the booking is cancelled, the draft is deleted.</p>
          <label style={{ marginTop: 12 }}>Welcome message on the booking page<textarea rows={3} maxLength={1000} value={form.welcome} onChange={(e) => set('welcome', e.target.value)} /></label>
          <p className="muted">Opening hours and booking times all use this time zone. Visitors see times in it too.</p>
          {manager && <div className="form-actions"><button disabled={busy} className="primary">Save</button></div>}
        </fieldset>
        {!manager && <p className="muted">Only owners and admins can change these.</p>}
      </form>
    </div>
  );
}

// Each person's own bookings in Google Calendar, Outlook or Apple Calendar. Calendar apps can't
// sign in, so the private link itself lets them read it. It is read-only.
function CalendarFeed({ canEdit, onNotice, onError }: {
  canEdit: boolean; onNotice: (text: string) => void; onError: (text: string) => void;
}) {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    api.get('/api/scheduler/feed').then((result) => setToken(result.token)).catch((err) => onError(err.message));
  }, []);

  const url = token ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/api/book/feed/${token}.ics` : '';

  const { busy, run: once } = useSubmit();
  const make = () => once(async () => {
    if (token && !window.confirm('Make a new link? Calendars using the old link will stop updating.')) return;
    try {
      const result = await api.post('/api/scheduler/feed', {});
      setToken(result.token);
      onNotice(token ? 'New calendar link made' : 'Calendar link made');
    } catch (err: any) {
      onError(err.message);
    }
  });

  const stop = () => once(async () => {
    if (!window.confirm('Turn off your calendar link? Calendars using it will stop updating.')) return;
    try {
      await api.delete('/api/scheduler/feed');
      setToken(null);
      onNotice('Calendar link turned off');
    } catch (err: any) {
      onError(err.message);
    }
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      onNotice('Calendar link copied');
    } catch {
      onNotice('Select the link and copy it');
    }
  };

  return (
    <div className="card">
      <h2>See your bookings in your own calendar</h2>
      <p className="muted">Subscribe to this link in Google Calendar ("Other calendars", then "From URL"), Outlook ("Add calendar", then "Subscribe from web") or Apple Calendar. It shows your bookings from the last 60 days and the next year, and your video meetings. Calendar apps check it every few hours. It is read-only: changes are made here.</p>
      {token === undefined && <Skeleton width="70%" height={34} />}
      {token === null && (canEdit
        ? <button disabled={busy} type="button" className="primary" onClick={make}>Make my calendar link</button>
        : <p className="muted">Viewers don't take bookings, so there's no calendar link.</p>)}
      {token && (
        <>
          <div className="booking-link">
            <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Calendar link" />
            <button type="button" className="always" onClick={copy}>Copy</button>
          </div>
          <p className="muted">Anyone with this link can see your bookings, including customer names and phone numbers. Keep it private.</p>
          <p className="row-actions">
            {canEdit && <button disabled={busy} type="button" onClick={make}>Make a new link</button>}
            <button disabled={busy} type="button" className="danger" onClick={stop}>Turn off</button>
          </p>
        </>
      )}
    </div>
  );
}

// Busy times from the person's own calendar, so visitors can't book them over a dentist visit
// or a school run. We keep only start and end times; nobody sees what the events are.
type BusyStatus = {
  now: string;
  checks_on: boolean;
  feed: null | {
    hint: string; busy_count: number; last_error: string | null;
    last_checked_at: string | null; last_synced_at: string | null;
  };
};

const ago = (iso: string, skew: number) => {
  const minutes = Math.max(0, Math.round((Date.now() - skew - Date.parse(iso)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
};

function BusyCalendar({ canEdit, onNotice, onError }: {
  canEdit: boolean; onNotice: (text: string) => void; onError: (text: string) => void;
}) {
  const [status, setStatus] = useState<BusyStatus | null>(null);
  const [skew, setSkew] = useState(0);
  const [address, setAddress] = useState('');
  const [changing, setChanging] = useState(false);
  const [, setTick] = useState(0);

  const show = (next: BusyStatus) => {
    setStatus(next);
    setSkew(Date.now() - Date.parse(next.now));
  };

  useEffect(() => {
    api.get('/api/scheduler/busy-feed').then(show).catch((err) => onError(err.message));
    // Keeps "5 minutes ago" up to date
    const timer = window.setInterval(() => setTick((n) => n + 1), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const { busy, run: once } = useSubmit();
  const save = (event: FormEvent) => {
    event.preventDefault();
    return once(async () => {
      try {
        const next = await api.put('/api/scheduler/busy-feed', { url: address });
        show(next);
        setAddress('');
        setChanging(false);
        onNotice(next.feed?.last_error ? 'Saved, but we couldn’t read your calendar yet' : 'Saved. Your busy times are now blocked.');
      } catch (err: any) {
        onError(err.message);
      }
    });
  };

  const checkNow = () => once(async () => {
    try {
      const next = await api.post('/api/scheduler/busy-feed/check', {});
      show(next);
      onNotice(next.feed?.last_error ? 'Checked, but there was a problem' : 'Checked');
    } catch (err: any) {
      onError(err.message);
    }
  });

  const remove = () => once(async () => {
    if (!window.confirm('Stop blocking your busy times? Your calendar address will be deleted from get-ly.')) return;
    try {
      show(await api.delete('/api/scheduler/busy-feed'));
      onNotice('Removed. Your own calendar no longer blocks times.');
    } catch (err: any) {
      onError(err.message);
    }
  });

  const feed = status?.feed;
  const form = (
    <form onSubmit={save}>
      <label>Secret address in iCal format
        <input type="url" required value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" spellCheck={false}
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" />
      </label>
      <div className="form-actions">
        <button disabled={busy} className="primary">Save</button>
        {changing && <button disabled={busy} type="button" onClick={() => { setChanging(false); setAddress(''); }}>Back</button>}
      </div>
    </form>
  );

  return (
    <div className="card">
      <h2>Block my busy times</h2>
      <p className="muted">Paste the private address of your own Google, Outlook or Apple calendar. We check it every 15 minutes, and times you are busy there are not offered to visitors. We only keep when you are busy. Nobody here sees what your events are.</p>
      <details>
        <summary>Where do I find the address?</summary>
        <ul>
          <li><strong>Google Calendar</strong>: Settings, then your calendar under "Settings for my calendars", then "Integrate calendar". Copy "Secret address in iCal format".</li>
          <li><strong>Outlook</strong>: Settings, then Calendar, then "Shared calendars". Under "Publish a calendar", choose your calendar and "Can view when I'm busy", then Publish. Copy the ICS link.</li>
          <li><strong>Apple iCloud</strong>: in Calendar on iCloud.com, share your calendar as a "Public Calendar" and copy the link.</li>
        </ul>
        <p className="muted">Events marked "free" and cancelled events don't block anything. If you also subscribe to your get-ly calendar link, those bookings are not counted twice.</p>
      </details>

      {!status && <Skeleton width="70%" height={34} style={{ marginTop: 12 }} />}
      {status && !feed && (canEdit ? form : <p className="muted">Viewers don't take bookings, so there's nothing to block.</p>)}
      {status && feed && (
        <>
          <p>Your calendar: <strong>{feed.hint}</strong></p>
          {!status.checks_on && <p className="muted">Automatic checks are not switched on yet, so busy times from your calendar are not blocked. Your address is saved and will be used once they are.</p>}
          {status.checks_on && !feed.last_synced_at && !feed.last_error && <p className="muted">Waiting for the first check.</p>}
          {feed.last_error && feed.last_checked_at && (
            <p className="error">Checked {ago(feed.last_checked_at, skew)}: {feed.last_error}
              {feed.last_synced_at && ` Busy times from the last good check (${ago(feed.last_synced_at, skew)}) are still blocked.`}</p>
          )}
          {!feed.last_error && feed.last_synced_at && (
            <p className="muted">Last checked {ago(feed.last_synced_at, skew)}. {feed.busy_count === 1 ? '1 busy time' : `${feed.busy_count} busy times`} in the next 60 days.</p>
          )}
          {changing ? form : (
            <p className="row-actions">
              {canEdit && status.checks_on && <button disabled={busy} type="button" onClick={checkNow}>Check now</button>}
              {canEdit && <button disabled={busy} type="button" onClick={() => setChanging(true)}>Change address</button>}
              <button disabled={busy} type="button" className="danger" onClick={remove}>Remove</button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
