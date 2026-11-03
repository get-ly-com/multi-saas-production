import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { LOCATIONS, addDays, dayLabel } from '@/components/SchedulerNav';
import { money } from '@/lib/api';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
const WINDOW = 7;

const getJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || 'Too many tries. Please wait a minute and try again.');
  return result;
};

// Public, so it can be shared or linked from a website. It must not touch sign-in or the company choice.
export default function BookingPage() {
  const router = useRouter();
  const key = router.query.key as string | undefined;
  // Which campaign the visitor came from, from this page's own link
  const rawCampaign = router.query.utm_campaign ?? router.query.campaign;
  const campaign = (Array.isArray(rawCampaign) ? rawCampaign[0] : rawCampaign || '').trim().slice(0, 100).trim();
  const [info, setInfo] = useState<any>(null);
  const [closed, setClosed] = useState(false);
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [from, setFrom] = useState('');
  const [slots, setSlots] = useState<any[] | null>(null);
  const [slot, setSlot] = useState<any>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '', website: '' });
  const [done, setDone] = useState<any>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [cancelLink, setCancelLink] = useState('');

  useEffect(() => {
    if (!key) return;
    getJson(`/api/book/${encodeURIComponent(key)}`)
      .then((result) => {
        setInfo(result);
        setFrom(result.today);
        if (result.services.length === 1) setServiceId(result.services[0].id);
      })
      .catch(() => setClosed(true));
  }, [key]);

  const service = info?.services.find((row: any) => row.id === serviceId);
  const lastDay = info ? addDays(info.today, info.max_days_ahead) : '';

  useEffect(() => {
    if (!service || !from) return;
    setSlots(null);
    const params = new URLSearchParams({ service: service.id, from, days: String(WINDOW) });
    if (staffId) params.set('staff', staffId);
    getJson(`/api/book/${encodeURIComponent(key as string)}/slots?${params}`)
      .then(setSlots)
      .catch((err) => { setSlots([]); setError(err.message); });
  }, [serviceId, staffId, from]);

  useEffect(() => {
    if (done?.token) setCancelLink(`${window.location.origin}/book/cancel/${done.token}`);
  }, [done]);

  const chooseService = (id: string) => {
    setServiceId(id);
    setStaffId('');
    setSlot(null);
    setError('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError('');
    try {
      const result = await getJson(`/api/book/${encodeURIComponent(key as string)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, service_id: service.id, staff_id: staffId || null, start: slot.start, campaign })
      });
      setDone(result);
    } catch (err: any) {
      setError(err.message);
      // The time may have just gone, so show fresh times
      if (/no longer free|already booked|away on leave|closed that day/i.test(err.message)) {
        setSlot(null);
        setSlots(null);
        const params = new URLSearchParams({ service: service.id, from, days: String(WINDOW) });
        if (staffId) params.set('staff', staffId);
        getJson(`/api/book/${encodeURIComponent(key as string)}/slots?${params}`).then(setSlots).catch(() => setSlots([]));
      }
    } finally {
      setSending(false);
    }
  };

  const byDay: Record<string, any[]> = {};
  for (const row of slots || []) (byDay[row.date] = byDay[row.date] || []).push(row);

  return (
    <div className="public-form booking-page">
      <Head><title>{info ? `Book with ${info.company}` : 'Book a time'}</title></Head>
      {closed && <p className="empty">This booking page is not available.</p>}

      {done && (
        <div className="stack">
          {done.token ? (
            <>
              <h1>You're booked</h1>
              <div className="card">
                <p><strong>{done.service}</strong> with {done.with}</p>
                <p>{dayLabel(done.local_date, true)}, {done.start_time} to {done.end_time} ({done.time_zone})</p>
                <p>{LOCATIONS[done.location_type]}{done.location_detail ? `: ${done.location_detail}` : ''}</p>
                {done.room_url && (
                  <p>Video link: <a href={done.room_url} target="_blank" rel="noopener noreferrer">{done.room_url}</a><br />
                    <span className="muted">Calls run on Jitsi Meet, a free video service. Open the link at the time of your booking.</span></p>
                )}
              </div>
              <div className="card">
                <p><strong>Save this page's link.</strong> We don't send emails, so this is how you get back to your booking or cancel it:</p>
                <p><Link href={`/book/cancel/${done.token}`}>{cancelLink || 'Manage your booking'}</Link></p>
              </div>
            </>
          ) : <p>Thank you.</p>}
        </div>
      )}

      {info && !done && (
        <div className="stack">
          <h1>Book with {info.company}</h1>
          {info.welcome && <p className="wrap">{info.welcome}</p>}
          {info.services.length === 0 && <p className="empty">There's nothing to book right now.</p>}

          {info.services.length > 1 && (
            <div className="stack" style={{ gap: 8 }}>
              <h2>Choose a service</h2>
              {info.services.map((row: any) => (
                <button key={row.id} type="button" className={`service-choice ${row.id === serviceId ? 'chosen' : ''}`} onClick={() => chooseService(row.id)}>
                  <strong>{row.name}</strong>
                  <span>{row.duration_minutes} min · {LOCATIONS[row.location_type]}{row.price !== null ? ` · ${money(row.price, info.currency || 'USD')}` : ''}</span>
                  {row.description && <small>{row.description}</small>}
                </button>
              ))}
            </div>
          )}
          {info.services.length === 1 && service && (
            <p><strong>{service.name}</strong> · {service.duration_minutes} min · {LOCATIONS[service.location_type]}{service.price !== null ? ` · ${money(service.price, info.currency || 'USD')}` : ''}
              {service.description && <><br /><span className="muted">{service.description}</span></>}</p>
          )}

          {service && service.staff.length === 0 && <p className="empty">Nobody is taking bookings for this right now.</p>}
          {service && service.staff.length > 1 && (
            <label>With
              <select value={staffId} onChange={(e) => { setStaffId(e.target.value); setSlot(null); }}>
                <option value="">Anyone</option>
                {service.staff.map((row: any) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
          )}

          {service && service.staff.length > 0 && !slot && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="page-head" style={{ marginBottom: 0 }}>
                <h2 style={{ margin: 0 }}>Pick a time</h2>
                <div className="row-actions">
                  <button type="button" disabled={from <= info.today} onClick={() => setFrom(addDays(from, -WINDOW) < info.today ? info.today : addDays(from, -WINDOW))}>Earlier</button>
                  <button type="button" disabled={addDays(from, WINDOW) > lastDay} onClick={() => setFrom(addDays(from, WINDOW))}>Later</button>
                </div>
              </div>
              <p className="muted">Times are in {info.time_zone}.</p>
              {slots === null && <p>Loading times…</p>}
              {slots?.length === 0 && <p className="empty">No free times in these days. Try later dates.</p>}
              {Object.entries(byDay).map(([date, times]) => (
                <div key={date}>
                  <div className="stat-label">{dayLabel(date, true)}</div>
                  <div className="slot-list">
                    {times.map((row) => <button type="button" key={row.start} onClick={() => setSlot(row)}>{row.time}</button>)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {slot && (
            <form onSubmit={submit} className="stack">
              <div className="card">
                <strong>{service.name}</strong>, {dayLabel(slot.date, true)} at {slot.time} ({info.time_zone})
                <div><button type="button" className="link" onClick={() => setSlot(null)}>Choose another time</button></div>
              </div>
              <label>Your name<input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label>Email<input type="email" required maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
              <label>Phone{service.location_type === 'phone' ? '' : ' (optional)'}
                <input required={service.location_type === 'phone'} maxLength={40} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </label>
              <label>Anything we should know? (optional)<textarea rows={3} maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
              <label className="trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></label>
              {service.location_type === 'video' && <p className="muted">You'll get a video link after booking. Calls run on Jitsi Meet, a free video service.</p>}
              {error && <p className="error">{error}</p>}
              <div><button className="primary" disabled={sending}>{sending ? 'Booking…' : 'Book'}</button></div>
            </form>
          )}
          {!slot && error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
