import Head from 'next/head';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { LOCATIONS, dayLabel } from '@/components/SchedulerNav';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

// A visitor's own booking, reached by the secret link they got when booking. No sign-in.
export default function ManageBooking() {
  const router = useRouter();
  const token = router.query.token as string | undefined;
  const [booking, setBooking] = useState<any>(null);
  const [missing, setMissing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`${BASE_URL}/api/book/cancel/${encodeURIComponent(token)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then(setBooking)
      .catch(() => setMissing(true));
  }, [token]);

  const cancel = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.confirm('Cancel this booking?')) return;
    setSending(true);
    try {
      const response = await fetch(`${BASE_URL}/api/book/cancel/${encodeURIComponent(token as string)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Too many tries. Please wait a minute and try again.');
      setBooking(result);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="public-form">
      <Head><title>Your booking</title></Head>
      {missing && <p className="empty">We couldn't find this booking. Check the link.</p>}
      {booking && (
        <div className="stack">
          <h1>Your booking with {booking.company}</h1>
          <div className="card">
            <p><strong>{booking.service}</strong> with {booking.with}</p>
            <p>{dayLabel(booking.local_date, true)}, {booking.start_time} to {booking.end_time} ({booking.time_zone})</p>
            <p>{LOCATIONS[booking.location_type]}{booking.location_detail ? `: ${booking.location_detail}` : ''}</p>
            {booking.room_url && (
              <p><a className="button primary" href={booking.room_url} target="_blank" rel="noopener noreferrer">Join video call</a><br />
                <span className="muted">Calls run on Jitsi Meet, a free video service.</span></p>
            )}
            <p><span className={`badge ${booking.status === 'booked' ? 'paid' : 'void'}`}>{booking.status === 'booked' ? 'booked' : 'cancelled'}</span></p>
          </div>
          {booking.can_cancel && (
            <form onSubmit={cancel} className="stack">
              <label>Reason for cancelling (optional)<textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              {error && <p className="error">{error}</p>}
              <div><button className="danger" disabled={sending}>Cancel booking</button></div>
            </form>
          )}
          {booking.status === 'cancelled' && <p>This booking is cancelled. You can book again from the company's booking page.</p>}
          {booking.status === 'booked' && !booking.can_cancel && <p className="muted">This booking has started, so it can't be cancelled here. Please contact {booking.company}.</p>}
          <p className="muted">To change the time, cancel this booking and book a new one.</p>
        </div>
      )}
    </div>
  );
}
