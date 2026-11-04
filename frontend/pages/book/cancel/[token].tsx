import Head from 'next/head';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { AddToCalendar, AnswerList } from '@/components/SchedulerForms';
import { LOCATIONS, addDays, dayLabel, placesText } from '@/components/SchedulerNav';
import useSubmit from '@/lib/useSubmit';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
const WINDOW = 7;
// How far ahead "Later" may go when the server doesn't say
const MAX_DAYS_AHEAD = 60;

const getJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || (response.status === 429 ? 'Too many tries. Please wait a minute and try again.' : 'Something went wrong. Please try again.'));
  return result;
};

// A visitor's own booking, reached by the secret link they got when booking. No sign-in.
// They can add it to their calendar, move it to another free time, or cancel it.
export default function ManageBooking() {
  const router = useRouter();
  const token = router.query.token as string | undefined;
  const [booking, setBooking] = useState<any>(null);
  const [missing, setMissing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [moving, setMoving] = useState(false);
  const [from, setFrom] = useState('');
  const [slots, setSlots] = useState<any[] | null>(null);

  const path = token ? `/api/book/cancel/${encodeURIComponent(token)}` : '';

  useEffect(() => {
    if (!token) return;
    getJson(path).then(setBooking).catch(() => setMissing(true));
  }, [token]);

  const loadSlots = (day: string) => {
    setSlots(null);
    getJson(`${path}/slots?${new URLSearchParams({ from: day, days: String(WINDOW) })}`)
      .then(setSlots)
      .catch((err) => { setSlots([]); setError(err.message); });
  };

  useEffect(() => {
    if (moving && from) loadSlots(from);
  }, [moving, from]);

  // The company's own today and booking horizon when the server sends them; otherwise the visitor's today and a 60 day cap
  const firstDay = /^\d{4}-\d{2}-\d{2}$/.test(booking?.today || '') ? booking.today : todayIn();
  const daysAhead = Number.isInteger(booking?.max_days_ahead) && booking.max_days_ahead > 0 ? booking.max_days_ahead : MAX_DAYS_AHEAD;
  const lastDay = addDays(firstDay, daysAhead);

  const startMoving = () => {
    setError('');
    setNotice('');
    setFrom(firstDay);
    setMoving(true);
  };

  const move = async (slot: any) => {
    if (!window.confirm(`Move your booking to ${dayLabel(slot.date, true)} at ${slot.time}?`)) return;
    setSending(true);
    try {
      const result = await getJson(`${path}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: slot.start })
      });
      setBooking(result);
      setMoving(false);
      setError('');
      setNotice('Your booking has been moved. If you added it to your calendar, add it again with the new time.');
    } catch (err: any) {
      setError(err.message);
      if (/no longer free|session is full|already booked/i.test(err.message)) loadSlots(from);
    } finally {
      setSending(false);
    }
  };

  const { busy, run } = useSubmit();
  const cancel = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      if (!window.confirm('Cancel this booking?')) return;
      setSending(true);
      try {
        const result = await getJson(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        setBooking(result);
        setError('');
        setNotice('');
      } catch (err: any) {
        setError(err.message);
      } finally {
        setSending(false);
      }
    });
  };

  const byDay: Record<string, any[]> = {};
  for (const row of slots || []) (byDay[row.date] = byDay[row.date] || []).push(row);

  return (
    <div className="public-form">
      <Head><title>Your booking</title></Head>
      {missing && <p className="empty">We couldn't find this booking. Check the link.</p>}
      {booking && (
        <div className="stack">
          <h1>Your booking with {booking.company}</h1>
          {notice && <p className="notice">{notice}</p>}
          <div className="card">
            <p><strong>{booking.service}</strong> with {booking.with}{booking.group ? ' (group session)' : ''}</p>
            <p>{dayLabel(booking.local_date, true)}, {booking.start_time} to {booking.end_time} ({booking.time_zone})</p>
            <p>{LOCATIONS[booking.location_type]}{booking.location_detail ? `: ${booking.location_detail}` : ''}</p>
            {booking.room_url && (
              <p><a className="button primary" href={booking.room_url} target="_blank" rel="noopener noreferrer">Join video call</a><br />
                <span className="muted">Calls run on Jitsi Meet, a free video service.</span></p>
            )}
            <p><span className={`badge ${booking.status === 'booked' ? 'paid' : 'void'}`}>{booking.status === 'booked' ? 'booked' : 'cancelled'}</span></p>
            <AnswerList answers={booking.answers} />
            {token && <AddToCalendar booking={booking} token={token} />}
          </div>

          {booking.can_reschedule && !moving && (
            <div>
              <button type="button" className="primary" onClick={startMoving}>Change the time</button>
              <span className="muted"> You can move it {booking.moves_left === 1 ? 'once more' : `${booking.moves_left} more times`}.</span>
            </div>
          )}
          {moving && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="page-head" style={{ marginBottom: 0 }}>
                <h2 style={{ margin: 0 }}>Pick a new time with {booking.with}</h2>
                <div className="row-actions">
                  <button type="button" disabled={from <= firstDay} onClick={() => setFrom(addDays(from, -WINDOW) < firstDay ? firstDay : addDays(from, -WINDOW))}>Earlier</button>
                  <button type="button" disabled={addDays(from, WINDOW) > lastDay} onClick={() => setFrom(addDays(from, WINDOW))}>Later</button>
                  <button type="button" onClick={() => setMoving(false)}>Keep my time</button>
                </div>
              </div>
              <p className="muted">Times are in {booking.time_zone}.</p>
              {slots === null && <p>Loading times…</p>}
              {slots?.length === 0 && <p className="empty">No free times in these days. Try later dates.</p>}
              {Object.entries(byDay).map(([date, times]) => (
                <div key={date}>
                  <div className="stat-label">{dayLabel(date, true)}</div>
                  <div className="slot-list">
                    {times.map((row) => (
                      <button type="button" key={row.start} disabled={sending} className={row.start === booking.starts_at ? 'primary' : ''}
                        onClick={() => row.start !== booking.starts_at && move(row)}>
                        {row.time}{row.seats_left ? <small className="slot-places"> {placesText(row.seats_left)}</small> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && <p className="error">{error}</p>}
          {booking.can_cancel && !moving && (
            <form onSubmit={cancel} className="stack">
              <label>Reason for cancelling (optional)<textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <div><button className="danger" disabled={busy || sending}>Cancel booking</button></div>
            </form>
          )}
          {booking.status === 'cancelled' && <p>This booking is cancelled. You can book again from the company's booking page.</p>}
          {booking.status === 'booked' && !booking.can_cancel && <p className="muted">This booking has started, so it can't be changed here. Please contact {booking.company}.</p>}
          {booking.status === 'booked' && booking.can_cancel && !booking.can_reschedule && (
            <p className="muted">To change the time, please contact {booking.company}, or cancel and book again.</p>
          )}
        </div>
      )}
    </div>
  );
}

// Today as YYYY-MM-DD on the visitor's device. The server checks real availability and notice.
function todayIn() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
