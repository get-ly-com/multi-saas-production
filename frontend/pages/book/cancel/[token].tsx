import Head from 'next/head';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { AddToCalendar, AnswerList } from '@/components/SchedulerForms';
import { LOCATIONS, addDays, dayLabel, placesText } from '@/components/SchedulerNav';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import useSubmit from '@/lib/useSubmit';
import p from '@/styles/public.module.css';

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
    <div className={p.page}>
      <Head><title>Your booking</title></Head>
      <div className={p.narrow}>
        {missing && (
          <div className={`${p.panel} ${p.message}`}>
            <div className="empty-state is-compact">
              <div className="empty-art" aria-hidden="true"><span className="empty-ring" /><Icon name="scheduler" size={20} /></div>
              <h3>We couldn&apos;t find this booking</h3>
              <p>Check the link you saved when you booked.</p>
            </div>
          </div>
        )}
        {!booking && !missing && (
          <div className={`${p.panel} ${p.payBody}`} role="status" aria-label="Loading"><Skeleton width="60%" height={24} /><Skeleton height={120} radius={12} /></div>
        )}
        {booking && (
          <>
            <div className={p.brand}>
              <div className={p.logo} aria-hidden="true">{(booking.company || '?').charAt(0).toUpperCase()}</div>
              <div><div className={p.brandName}>{booking.company}</div><div className={p.brandLine}>Your booking</div></div>
            </div>
            <div className={p.panel}>
              <div className={p.payHead}>
                <span className={p.payLabel}>{booking.service}{booking.group ? ', group session' : ''}</span>
                <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 650, letterSpacing: '-0.02em' }}>{dayLabel(booking.local_date, true)}</span>
                <span className="muted">{booking.start_time} to {booking.end_time}, {booking.time_zone}</span>
                <span><span className={`badge ${booking.status === 'booked' ? 'booked' : 'cancelled'}`}>{booking.status === 'booked' ? 'booked' : 'cancelled'}</span></span>
              </div>
              <div className={p.payBody}>
                {notice && <p className="notice" style={{ margin: 0 }}>{notice}</p>}
                <dl className={p.payRows}>
                  <div><dt>With</dt><dd>{booking.with}</dd></div>
                  <div><dt>Where</dt><dd>{LOCATIONS[booking.location_type]}{booking.location_detail ? `: ${booking.location_detail}` : ''}</dd></div>
                </dl>
                {booking.room_url && (
                  <div>
                    <a className="button primary" href={booking.room_url} target="_blank" rel="noopener noreferrer"><Icon name="meetings" size={16} />Join video call</a>
                    <p className="muted small" style={{ margin: '6px 0 0' }}>Calls run on Jitsi Meet, a free video service.</p>
                  </div>
                )}
                <AnswerList answers={booking.answers} />
                {token && <AddToCalendar booking={booking} token={token} />}

                {booking.can_reschedule && !moving && (
                  <div className="row-actions" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <button type="button" className="primary" onClick={startMoving}>Change the time</button>
                    <span className="muted small">You can move it {booking.moves_left === 1 ? 'once more' : `${booking.moves_left} more times`}.</span>
                  </div>
                )}

                {moving && (
                  <div className="stack" style={{ gap: 12 }}>
                    <div className={p.weekHead}>
                      <strong>Pick a new time with {booking.with}</strong>
                      <div className="row-actions">
                        <button type="button" className="icon-button" aria-label="Earlier days" disabled={from <= firstDay}
                          onClick={() => setFrom(addDays(from, -WINDOW) < firstDay ? firstDay : addDays(from, -WINDOW))}><Icon name="chevron-left" size={18} /></button>
                        <button type="button" className="icon-button" aria-label="Later days" disabled={addDays(from, WINDOW) > lastDay}
                          onClick={() => setFrom(addDays(from, WINDOW))}><Icon name="chevron-right" size={18} /></button>
                      </div>
                    </div>
                    <p className="muted small" style={{ margin: 0 }}>Times are in {booking.time_zone}.</p>
                    {slots === null && <div className={p.times} aria-busy="true">{Array.from({ length: 6 }, (_, n) => <Skeleton key={n} height={42} radius={8} />)}</div>}
                    {slots?.length === 0 && <p className="muted" style={{ margin: 0 }}>No free times in these days. Try the next week with the arrow above.</p>}
                    {Object.entries(byDay).map(([date, times]) => (
                      <div key={date}>
                        <p className="muted small" style={{ marginBottom: 6 }}>{dayLabel(date, true)}</p>
                        <div className={p.times}>
                          {times.map((row) => (
                            <button type="button" key={row.start} disabled={sending} className={`${p.time} ${row.start === booking.starts_at ? 'primary' : ''}`}
                              aria-current={row.start === booking.starts_at ? 'true' : undefined}
                              onClick={() => row.start !== booking.starts_at && move(row)}>
                              {row.time}{row.seats_left ? <small>{placesText(row.seats_left)}</small> : null}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div><button type="button" onClick={() => setMoving(false)}>Keep my time</button></div>
                  </div>
                )}

                {error && <p className="error">{error}</p>}
                {booking.can_cancel && !moving && (
                  <form onSubmit={cancel} className="stack" style={{ gap: 10, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                    <label>Reason for cancelling (optional)<textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                    <div><button className="danger" disabled={busy || sending}>Cancel booking</button></div>
                  </form>
                )}
                {booking.status === 'cancelled' && <p className="muted" style={{ margin: 0 }}>This booking is cancelled. You can book again from the company&apos;s booking page.</p>}
                {booking.status === 'booked' && !booking.can_cancel && <p className="muted" style={{ margin: 0 }}>This booking has started, so it can&apos;t be changed here. Please contact {booking.company}.</p>}
                {booking.status === 'booked' && booking.can_cancel && !booking.can_reschedule && (
                  <p className="muted" style={{ margin: 0 }}>To change the time, please contact {booking.company}, or cancel and book again.</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Today as YYYY-MM-DD on the visitor's device. The server checks real availability and notice.
function todayIn() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
