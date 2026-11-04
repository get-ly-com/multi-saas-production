import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Modal from '@/components/Modal';
import { dayLabel } from '@/components/SchedulerNav';
import Skeleton from '@/components/Skeleton';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import s from '@/styles/scheduler.module.css';

export default function Meetings() {
  return <AppShell><MeetingsApp /></AppShell>;
}

function MeetingsApp() {
  const [setup, setSetup] = useState<any>(null);
  const [meetings, setMeetings] = useState<any[] | null>(null);
  const [past, setPast] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const load = async () => {
    try {
      const [overview, rows] = await Promise.all([
        setup ? Promise.resolve(setup) : api.get('/api/scheduler/overview'),
        api.get(`/api/video/meetings${past ? '?past=true' : ''}`)
      ]);
      setSetup(overview);
      setMeetings(rows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [past]);

  const { busy, run: once } = useSubmit();
  // The tab opens straight away so the browser doesn't block it, then goes to the new room.
  // It is cut off from this page so the room's site cannot reach back into it.
  const startNow = () => once(async () => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const meeting = await api.post('/api/video/meetings/now', {});
      if (tab) tab.location.href = meeting.room_url;
      else window.location.href = meeting.room_url;
      load();
    } catch (err: any) {
      tab?.close();
      setError(err.message);
    }
  });

  const cancel = (meeting: any) => once(async () => {
    if (!window.confirm(`Cancel "${meeting.title}"?`)) return;
    try {
      await api.post(`/api/video/meetings/${meeting.id}/cancel`, {});
      load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  const copyLink = async (meeting: any) => {
    try {
      await navigator.clipboard.writeText(meeting.room_url);
      setCopied(meeting.id);
      setTimeout(() => setCopied((current) => (current === meeting.id ? '' : current)), 2000);
    } catch {
      window.prompt('Copy this link', meeting.room_url);
    }
  };

  const canChange = (meeting: any) => setup?.can_edit && !meeting.booking_id && meeting.status === 'scheduled'
    && (setup.is_manager || meeting.host_id === setup.me);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Meetings</h1>
          <p className="muted">Video calls with customers and your team, one click to join.</p>
        </div>
        {setup?.can_edit && (
          <div className="row-actions">
            <button onClick={() => setEditing({ title: '', date: setup.today, time: '', duration_minutes: '30', notes: '', contacts: [] })}>Schedule a meeting</button>
            <button disabled={busy} className="primary" onClick={startNow}><Icon name="meetings" size={16} />Start now</button>
          </div>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      <div className="tabs">
        <button className={!past ? 'active' : ''} onClick={() => setPast(false)}>Upcoming</button>
        <button className={past ? 'active' : ''} onClick={() => setPast(true)}>Past and cancelled</button>
      </div>

      {meetings === null && (
        <div className={s.meetings} aria-busy="true">
          {[0, 1, 2].map((n) => (
            <div key={n} className={s.meetingCard}>
              <Skeleton width={64} height={56} radius={8} />
              <div style={{ display: 'grid', gap: 6 }}><Skeleton width="40%" height={15} /><Skeleton width="65%" height={12} /></div>
              <Skeleton width={72} height={34} radius={8} />
            </div>
          ))}
        </div>
      )}

      {meetings?.length === 0 && (
        <div className="card">
          {past
            ? <EmptyState icon="meetings" title="No past meetings yet" line="Meetings you've held or cancelled will show here." />
            : <EmptyState icon="meetings" title="No meetings coming up"
                line="Start a call now and share the link, or schedule one for later."
                action={setup?.can_edit ? { label: 'Start now', onClick: startNow } : undefined}
                secondary={setup?.can_edit ? { label: 'Schedule a meeting', onClick: () => setEditing({ title: '', date: setup.today, time: '', duration_minutes: '30', notes: '', contacts: [] }) } : undefined} />}
        </div>
      )}

      {meetings && meetings.length > 0 && (
        <div className={s.meetings}>
          {meetings.map((meeting) => {
            const date = new Date(`${meeting.local_date}T00:00:00Z`);
            return (
              <article key={meeting.id} className={`${s.meetingCard} ${meeting.is_live ? s.live : ''}`} style={meeting.status === 'cancelled' ? { opacity: 0.65 } : undefined}>
                <div className={s.dateTile} aria-hidden="true">
                  <small>{date.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short' })}</small>
                  <strong>{date.getUTCDate()}</strong>
                </div>
                <div className={s.meetingText}>
                  <h3>
                    {meeting.title}
                    {meeting.is_live && <span className={s.livePill}>Live now</span>}
                    {meeting.status === 'cancelled' && <span className="badge cancelled">cancelled</span>}
                    {meeting.booking_id && <span className="chip">From a booking</span>}
                  </h3>
                  <span>
                    {dayLabel(meeting.local_date, true)} at {meeting.start_time} · {meeting.duration_minutes} min
                    {setup ? ` · ${setup.settings.time_zone}` : ''}
                  </span>
                  <span>
                    {meeting.host_name ? `Hosted by ${meeting.host_name}` : ''}
                    {meeting.contacts.length > 0 && <>{meeting.host_name ? ' · with ' : 'With '}
                      {meeting.contacts.map((contact: any, i: number) => (
                        <span key={contact.id}>{i > 0 && ', '}<Link href={`/saas/crm/contact/${contact.id}`}>{contact.name}</Link></span>
                      ))}</>}
                  </span>
                </div>
                {meeting.status === 'scheduled' && (
                  <div className={s.meetingActions}>
                    {canChange(meeting) && !past && (
                      <>
                        <button type="button" className="ghost small" onClick={() => setEditing({ ...meeting, date: meeting.local_date, time: meeting.start_time, duration_minutes: String(meeting.duration_minutes) })}>Edit</button>
                        <button type="button" className="ghost small danger" disabled={busy} onClick={() => cancel(meeting)}>Cancel</button>
                      </>
                    )}
                    <button type="button" className="small always" onClick={() => copyLink(meeting)} aria-live="polite">
                      <Icon name={copied === meeting.id ? 'check' : 'copy'} size={14} />{copied === meeting.id ? 'Copied' : 'Copy link'}
                    </button>
                    <a className="button primary always" href={meeting.room_url} target="_blank" rel="noopener noreferrer"><Icon name="meetings" size={16} />Join</a>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <p className="muted small">Calls run on Jitsi Meet, a free video service. Anyone with a meeting&apos;s link can join, so share it only with the people you invite. Video bookings from <Link href="/saas/scheduler">Scheduler</Link> show here too.</p>

      {editing && setup && <MeetingForm initial={editing} timeZone={setup.settings.time_zone} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}


function MeetingForm({ initial, timeZone, onClose, onSaved }: { initial: any; timeZone: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [error, setError] = useState('');
  const set = (field: string, value: any) => setForm({ ...form, [field]: value });

  useEffect(() => {
    if (search.trim().length < 2) return setFound([]);
    const timer = setTimeout(() => {
      api.get(`/api/video/contacts?search=${encodeURIComponent(search.trim())}`).then(setFound).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        const body = { ...form, contact_ids: form.contacts.map((contact: any) => contact.id) };
        if (form.id) await api.put(`/api/video/meetings/${form.id}`, body);
        else await api.post('/api/video/meetings', body);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? 'Edit meeting' : 'Schedule a meeting'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Title<input required maxLength={200} value={form.title} onChange={(e) => set('title', e.target.value)} /></label>
          <label>Date<input type="date" required value={form.date} onChange={(e) => set('date', e.target.value)} /></label>
          <label>Time ({timeZone})<input type="time" required value={form.time} onChange={(e) => set('time', e.target.value)} /></label>
          <label>Length (minutes)<input type="number" min={5} max={720} required value={form.duration_minutes} onChange={(e) => set('duration_minutes', e.target.value)} /></label>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="stat-label">Invite CRM contacts</div>
          <div className="crm-search" style={{ width: '100%' }}>
            <input aria-label="Search contacts" placeholder="Search contacts" value={search} onChange={(e) => setSearch(e.target.value)} />
            {found.length > 0 && (
              <div className="crm-results">
                {found.filter((contact) => !form.contacts.some((c: any) => c.id === contact.id)).map((contact) => (
                  <button type="button" key={contact.id} className="bell-item" onClick={() => { set('contacts', [...form.contacts, contact]); setSearch(''); }}>
                    {contact.name}<small>{contact.email || ''}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="starters" style={{ marginTop: 8 }}>
            {form.contacts.map((contact: any) => (
              <span key={contact.id} className="badge">{contact.name} <button type="button" className="link" aria-label={`Remove ${contact.name}`}
                onClick={() => set('contacts', form.contacts.filter((c: any) => c.id !== contact.id))}>×</button></span>
            ))}
          </div>
          <p className="muted">The meeting is added to each contact's CRM timeline. We don't send invitations, so share the link with them yourself.</p>
        </div>
        <label style={{ marginTop: 12 }}>Notes<textarea rows={2} maxLength={2000} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">{form.id ? 'Save' : 'Schedule'}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
