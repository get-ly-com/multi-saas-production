import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { LOCATIONS, dayLabel } from '@/components/SchedulerNav';
import { api, money } from '@/lib/api';

// Leave (from HR) and company holidays block a day. Staff can still book after this warning.
const AWAY = /away on leave|closed that day/i;

function AwayWarning({ message, action, onConfirm, onBack }: {
  message: string; action: string; onConfirm: () => void; onBack: () => void;
}) {
  return (
    <div className="card" role="alert" style={{ marginTop: 12 }}>
      <p><strong>{message}.</strong> Free times skip this day. Only go ahead if you've checked it's fine.</p>
      <div className="form-actions">
        <button type="button" className="danger" onClick={onConfirm}>{action} anyway</button>
        <button type="button" onClick={onBack}>Pick another time</button>
      </div>
    </div>
  );
}

// Free start times on one day, with a box to type any other time
function TimePicker({ service, staff, date, booking, time, onPick }: {
  service: string; staff: string; date: string; booking?: string; time: string;
  onPick: (time: string, staffId?: string) => void;
}) {
  const [slots, setSlots] = useState<any[] | null>(null);

  useEffect(() => {
    if (!service || !date) return setSlots(null);
    const params = new URLSearchParams({ service, date });
    if (staff) params.set('staff', staff);
    if (booking) params.set('booking', booking);
    api.get(`/api/scheduler/free-times?${params}`).then(setSlots).catch(() => setSlots([]));
  }, [service, staff, date, booking]);

  if (!service || !date) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="stat-label">Free times{staff ? '' : ' (anyone)'}</div>
      {slots === null && <p className="muted">Loading…</p>}
      {slots?.length === 0 && <p className="muted">No free times in opening hours on this day.</p>}
      <div className="slot-list">
        {slots?.map((slot) => (
          <button type="button" key={`${slot.start}-${slot.staff_id}`} className={time === slot.time ? 'primary' : ''}
            onClick={() => onPick(slot.time, slot.staff_id)}>
            {slot.time}{staff ? '' : ` · ${slot.staff_name}`}
          </button>
        ))}
      </div>
      <label style={{ marginTop: 8 }}>Or type a time
        <input type="time" value={time} onChange={(e) => onPick(e.target.value)} />
      </label>
      <p className="muted">Typed times can be outside opening hours. The person still can't be booked twice at once. Free times skip HR leave and company holidays.</p>
    </div>
  );
}

function ContactSearch({ onPick }: { onPick: (contact: any) => void }) {
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);

  useEffect(() => {
    if (search.trim().length < 2) return setFound([]);
    const timer = setTimeout(() => {
      api.get(`/api/scheduler/contacts?search=${encodeURIComponent(search.trim())}`).then(setFound).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="crm-search" style={{ width: '100%' }}>
      <input placeholder="Find a CRM contact (optional)" value={search} onChange={(e) => setSearch(e.target.value)} />
      {found.length > 0 && (
        <div className="crm-results">
          {found.map((contact) => (
            <button type="button" key={contact.id} className="bell-item" onClick={() => { onPick(contact); setSearch(''); }}>
              {contact.name}<small>{contact.email || contact.phone || ''}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewBooking({ data, date, onClose, onSaved }: {
  data: any; date: string; onClose: () => void; onSaved: (booking: any) => void;
}) {
  const services = data.services.filter((row: any) => row.is_active);
  const staff = data.staff.filter((row: any) => row.set_up);
  const meSetUp = staff.some((row: any) => row.user_id === data.me);
  const [form, setForm] = useState<any>({
    service_id: services[0]?.id || '', staff_id: meSetUp ? data.me : staff[0]?.user_id || '', date, time: '',
    contact_id: '', name: '', email: '', phone: '', notes: ''
  });
  const [anyone, setAnyone] = useState(false);
  const [error, setError] = useState('');
  const [away, setAway] = useState('');
  const set = (field: string, value: any) => setForm({ ...form, [field]: value });

  const service = services.find((row: any) => row.id === form.service_id);
  const offered = staff.filter((row: any) => !service?.staff_ids?.length || service.staff_ids.includes(row.user_id));

  useEffect(() => setAway(''), [form.date, form.time, form.staff_id]);

  const send = async (overrideAway: boolean) => {
    try {
      const saved = await api.post('/api/scheduler/bookings', { ...form, override_away: overrideAway });
      onSaved(saved);
      onClose();
    } catch (err: any) {
      if (!overrideAway && AWAY.test(err.message)) {
        setAway(err.message);
        setError('');
      } else {
        setError(err.message);
      }
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(false);
  };

  if (!services.length || !staff.length) {
    return (
      <Modal title="New booking">
        <p>{!services.length ? 'Add a service first.' : 'Someone needs to set up their opening hours first.'}</p>
        <div className="form-actions">
          <Link className="primary" href={!services.length ? '/saas/scheduler/services' : '/saas/scheduler/hours'}>
            {!services.length ? 'Add a service' : 'Set up hours'}
          </Link>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="New booking">
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Service
            <select required value={form.service_id} onChange={(e) => set('service_id', e.target.value)}>
              {services.map((row: any) => <option key={row.id} value={row.id}>{row.name} ({row.duration_minutes} min)</option>)}
            </select>
          </label>
          <label>With
            <select value={anyone ? '' : form.staff_id} onChange={(e) => { setAnyone(!e.target.value); if (e.target.value) set('staff_id', e.target.value); }}>
              <option value="">Anyone free</option>
              {offered.map((row: any) => <option key={row.user_id} value={row.user_id}>{row.display_name}</option>)}
            </select>
          </label>
          <label>Date<input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value, time: '' })} /></label>
        </div>
        <TimePicker service={form.service_id} staff={anyone ? '' : form.staff_id} date={form.date} time={form.time}
          onPick={(time, staffId) => setForm({ ...form, time, ...(staffId ? { staff_id: staffId } : {}) })} />
        {anyone && form.time && <p className="muted">With {staff.find((row: any) => row.user_id === form.staff_id)?.display_name}</p>}

        <h2 style={{ marginTop: 16 }}>Customer</h2>
        <ContactSearch onPick={(contact) => setForm({ ...form, contact_id: contact.id, name: contact.name, email: contact.email || '', phone: contact.phone || '' })} />
        {form.contact_id && (
          <p className="muted">Linked to a CRM contact. <button type="button" className="link" onClick={() => set('contact_id', '')}>Unlink</button></p>
        )}
        <div className="form-grid" style={{ marginTop: 8 }}>
          <label>Name<input required maxLength={200} value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Email<input type="email" maxLength={254} value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
          <label>Phone<input maxLength={40} required={service?.location_type === 'phone'} value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        </div>
        <label style={{ marginTop: 12 }}>Notes<textarea rows={2} maxLength={2000} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        <p className="muted">With an email, the booking is added to that CRM contact's timeline (a new contact is made if needed).{service?.location_type === 'video' ? ' A Jitsi Meet video link is made for it.' : ''}{Number(service?.price) > 0 && data.settings?.draft_invoices !== false ? ' A draft invoice is made in Accounting for the service price.' : ''}</p>
        {away && <AwayWarning message={away} action="Book" onConfirm={() => send(true)} onBack={() => { setAway(''); set('time', ''); }} />}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={!form.time || !form.staff_id}>Book</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

export function BookingDetails({ booking, data, onClose, onSaved }: {
  booking: any; data: any; onClose: () => void; onSaved: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const [form, setForm] = useState({ date: booking.local_date, time: booking.start_time, staff_id: booking.staff_id || '' });
  const [error, setError] = useState('');
  const [away, setAway] = useState('');
  const service = data.services.find((row: any) => row.id === booking.service_id);
  const staff = data.staff.filter((row: any) => row.set_up && (!service?.staff_ids?.length || service.staff_ids.includes(row.user_id)));
  const live = booking.status === 'booked';

  const act = async (work: () => Promise<any>, warnAway = false) => {
    try {
      await work();
      onSaved();
      onClose();
    } catch (err: any) {
      if (warnAway && AWAY.test(err.message)) {
        setAway(err.message);
        setError('');
      } else {
        setError(err.message);
      }
    }
  };

  useEffect(() => setAway(''), [form.date, form.time, form.staff_id]);

  const move = (overrideAway: boolean) =>
    act(() => api.post(`/api/scheduler/bookings/${booking.id}/reschedule`, { ...form, override_away: overrideAway }), !overrideAway);

  const cancel = () => {
    const reason = window.prompt('Cancel this booking? You can add a reason (optional).');
    if (reason === null) return;
    act(() => api.post(`/api/scheduler/bookings/${booking.id}/cancel`, { reason }));
  };

  return (
    <Modal title={`${booking.service_name} with ${booking.customer_name}`}>
      <div className="facts">
        <div><div className="stat-label">When</div>{dayLabel(booking.local_date, true)}, {booking.start_time} to {booking.end_time}</div>
        <div><div className="stat-label">With</div>{booking.staff_name}</div>
        <div><div className="stat-label">Where</div>{LOCATIONS[booking.location_type]}{booking.location_detail ? `: ${booking.location_detail}` : ''}</div>
        <div><div className="stat-label">Status</div>
          <span className={`badge ${live ? 'paid' : 'void'}`}>{live ? 'booked' : 'cancelled'}</span>
          {!live && booking.cancelled_by_visitor ? ' by the customer' : ''}
        </div>
        <div><div className="stat-label">Customer</div>
          {booking.contact_id ? <Link href={`/saas/crm/contact/${booking.contact_id}`}>{booking.customer_name}</Link> : booking.customer_name}
          {booking.customer_email && <div className="muted">{booking.customer_email}</div>}
          {booking.customer_phone && <div className="muted">{booking.customer_phone}</div>}
        </div>
        <div><div className="stat-label">Booked</div>{booking.source === 'public' ? 'Online by the customer' : 'By the team'}
          {booking.campaign && <div className="muted">Campaign: {booking.campaign}</div>}
        </div>
        {(booking.invoice_id || booking.invoice_note) && (
          <div><div className="stat-label">Invoice</div>
            {booking.invoice_id && (
              <Link href={`/saas/accounting/invoice/${booking.invoice_id}`}>
                {booking.invoice_number || 'Open invoice'}{booking.invoice_status ? ` (${booking.invoice_status})` : ''}
              </Link>
            )}
            {booking.invoice_note && <div className="muted">{booking.invoice_note}</div>}
          </div>
        )}
      </div>
      {booking.notes && <p className="wrap">{booking.notes}</p>}
      {booking.cancel_reason && <p className="muted">Reason: {booking.cancel_reason}</p>}
      {live && booking.room_url && (
        <p><a className="button primary always" href={booking.room_url} target="_blank" rel="noopener noreferrer">Join video call</a>
          <span className="muted"> Calls run on Jitsi Meet, a free video service.</span></p>
      )}

      {moving && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="form-grid">
            <label>With
              <select value={form.staff_id} onChange={(e) => setForm({ ...form, staff_id: e.target.value, time: '' })}>
                {staff.map((row: any) => <option key={row.user_id} value={row.user_id}>{row.display_name}</option>)}
              </select>
            </label>
            <label>Date<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value, time: '' })} /></label>
          </div>
          <TimePicker service={booking.service_id} staff={form.staff_id} date={form.date} booking={booking.id} time={form.time}
            onPick={(time) => setForm({ ...form, time })} />
          <div className="form-actions">
            <button className="primary" disabled={!form.time} onClick={() => move(false)}>Move booking</button>
            <button type="button" onClick={() => setMoving(false)}>Back</button>
          </div>
          {away && <AwayWarning message={away} action="Move" onConfirm={() => move(true)} onBack={() => { setAway(''); setForm({ ...form, time: '' }); }} />}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        {live && data.can_edit && !moving && <button className="primary" onClick={() => setMoving(true)}>Reschedule</button>}
        {live && data.can_edit && <button className="danger" onClick={cancel}>Cancel booking</button>}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

export const priceText = (price: any, currency?: string) =>
  price === null || price === undefined || price === '' ? 'Free' : money(price, currency || undefined);
