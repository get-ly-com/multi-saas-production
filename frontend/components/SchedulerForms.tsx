import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { LOCATIONS, dayLabel, googleCalendarLink, placesText } from '@/components/SchedulerNav';
import { api, money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import { bookingReminderText, whatsappLink } from '@/lib/whatsapp';

// Leave (from HR) and company holidays block a day. Staff can still book after this warning.
const AWAY = /away on leave|closed that day|busy then in their own calendar/i;

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
            {slot.time}{staff ? '' : ` · ${slot.staff_name}`}{slot.seats_left ? ` · ${placesText(slot.seats_left)}` : ''}
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
      <input aria-label="Find a CRM contact" placeholder="Find a CRM contact (optional)" value={search} onChange={(e) => setSearch(e.target.value)} />
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

// The service's own questions. Online, required ones must be answered; staff can leave them.
export function Answers({ questions, value, onChange, online = false }: {
  questions: any[]; value: Record<string, string>; onChange: (value: Record<string, string>) => void; online?: boolean;
}) {
  if (!questions?.length) return null;
  const set = (id: string, answer: string) => onChange({ ...value, [id]: answer });
  return (
    <div className="stack" style={{ gap: 8, marginTop: 12 }}>
      {questions.map((q) => {
        const label = `${q.label}${q.required ? '' : ' (optional)'}`;
        const required = online && q.required;
        if (q.kind === 'choice' || q.kind === 'yes_no') {
          const options = q.kind === 'yes_no' ? ['Yes', 'No'] : q.options || [];
          return (
            <label key={q.id}>{label}
              <select required={required} value={value[q.id] || ''} onChange={(e) => set(q.id, e.target.value)}>
                <option value="">Choose…</option>
                {options.map((option: string) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          );
        }
        return (
          <label key={q.id}>{label}
            {q.kind === 'long'
              ? <textarea rows={3} maxLength={2000} required={required} value={value[q.id] || ''} onChange={(e) => set(q.id, e.target.value)} />
              : <input maxLength={300} required={required} value={value[q.id] || ''} onChange={(e) => set(q.id, e.target.value)} />}
          </label>
        );
      })}
    </div>
  );
}

export function AnswerList({ answers }: { answers: any[] }) {
  if (!answers?.length) return null;
  return (
    <dl className="sched-answers">
      {answers.map((row: any) => (
        <div key={row.id}><dt>{row.label}</dt><dd className="wrap">{row.answer}</dd></div>
      ))}
    </dl>
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
    contact_id: '', name: '', email: '', phone: '', notes: '', answers: {}
  });
  const [repeat, setRepeat] = useState({ every_weeks: '', times: '4' });
  const [result, setResult] = useState<any>(null);
  const [anyone, setAnyone] = useState(false);
  const [error, setError] = useState('');
  const [away, setAway] = useState('');
  const set = (field: string, value: any) => setForm({ ...form, [field]: value });

  const service = services.find((row: any) => row.id === form.service_id);
  const offered = staff.filter((row: any) => !service?.staff_ids?.length || service.staff_ids.includes(row.user_id));

  useEffect(() => setAway(''), [form.date, form.time, form.staff_id]);

  const { busy: sending, run: once } = useSubmit();
  const send = (overrideAway: boolean) => once(async () => {
    try {
      const saved = await api.post('/api/scheduler/bookings', {
        ...form, override_away: overrideAway, ...(repeat.every_weeks ? { repeat } : {})
      });
      if (saved.made) {
        // Repeats: show which dates were booked and which were skipped
        onSaved(saved.made[0]);
        setResult(saved);
        return;
      }
      onSaved(saved);
      onClose();
    } catch (err: any) {
      if (!overrideAway && !repeat.every_weeks && AWAY.test(err.message)) {
        setAway(err.message);
        setError('');
      } else {
        setError(err.message);
      }
    }
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(false);
  };

  if (result) {
    return (
      <Modal title="Repeat bookings made" onClose={onClose}>
        <p>{result.made.length} booking{result.made.length === 1 ? '' : 's'} made: {result.made.map((row: any) => dayLabel(row.local_date)).join(', ')}.</p>
        {result.skipped.length > 0 && (
          <>
            <p><strong>{result.skipped.length} date{result.skipped.length === 1 ? ' was' : 's were'} skipped:</strong></p>
            <ul>{result.skipped.map((row: any) => <li key={row.date}>{dayLabel(row.date, true)}: {row.reason}</li>)}</ul>
          </>
        )}
        <div className="form-actions"><button className="primary" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }

  if (!services.length || !staff.length) {
    return (
      <Modal title="New booking" onClose={onClose}>
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
    <Modal title="New booking" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Service
            <select required value={form.service_id} onChange={(e) => setForm({ ...form, service_id: e.target.value, answers: {} })}>
              {services.map((row: any) => <option key={row.id} value={row.id}>{row.name} ({row.duration_minutes} min{row.capacity > 1 ? `, group of ${row.capacity}` : ''})</option>)}
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
        <Answers questions={service?.questions || []} value={form.answers} onChange={(answers) => set('answers', answers)} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label>Repeat
            <select value={repeat.every_weeks} onChange={(e) => setRepeat({ ...repeat, every_weeks: e.target.value })}>
              <option value="">Does not repeat</option>
              <option value="1">Every week</option>
              <option value="2">Every 2 weeks</option>
              <option value="4">Every 4 weeks</option>
            </select>
          </label>
          {repeat.every_weeks && (
            <label>Number of bookings<input type="number" min={2} max={26} value={repeat.times} onChange={(e) => setRepeat({ ...repeat, times: e.target.value })} /></label>
          )}
        </div>
        {repeat.every_weeks && <p className="muted">Same time and person each time. Dates that are taken, closed or on leave are skipped and listed.</p>}
        <p className="muted">With an email, the booking is added to that CRM contact's timeline (a new contact is made if needed).{service?.location_type === 'video' ? ' A Jitsi Meet video link is made for it.' : ''}{Number(service?.price) > 0 && data.settings?.draft_invoices !== false ? ' A draft invoice is made in Accounting for the service price.' : ''}</p>
        {away && <AwayWarning message={away} action="Book" onConfirm={() => send(true)} onBack={() => { setAway(''); set('time', ''); }} />}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={sending || !form.time || !form.staff_id}>{repeat.every_weeks ? `Book ${repeat.times} times` : 'Book'}</button>
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

  const { busy, run: guard } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const act = (work: () => Promise<any>, warnAway = false) => guard(async () => {
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
  });

  useEffect(() => setAway(''), [form.date, form.time, form.staff_id]);

  const move = (overrideAway: boolean) =>
    act(() => api.post(`/api/scheduler/bookings/${booking.id}/reschedule`, { ...form, override_away: overrideAway }), !overrideAway);

  const cancel = () => {
    const reason = window.prompt('Cancel this booking? You can add a reason (optional).');
    if (reason === null) return;
    act(() => api.post(`/api/scheduler/bookings/${booking.id}/cancel`, { reason }));
  };

  const cancelRepeats = () => {
    const reason = window.prompt('Cancel this booking and every later one in the repeat? You can add a reason (optional).');
    if (reason === null) return;
    act(() => api.post(`/api/scheduler/bookings/${booking.id}/cancel-repeats`, { reason }));
  };

  // A WhatsApp reminder with the time and the customer's own reschedule/cancel link. The window opens
  // straight away (so it isn't blocked), then gets its address once the link is known.
  const sendWhatsApp = async () => {
    const opened = window.open('about:blank', '_blank');
    if (opened) opened.opener = null;
    let link = '';
    try {
      const { token } = await api.get(`/api/chatbot/whatsapp/booking-link/${booking.id}`);
      if (token) link = `${window.location.origin}/book/cancel/${token}`;
    } catch {
      // Without the link the reminder still has the time
    }
    const url = whatsappLink(booking.customer_phone, bookingReminderText({
      name: booking.customer_name, service: booking.service_name, staff: booking.staff_name,
      when: `${dayLabel(booking.local_date, true)} at ${booking.start_time}`, link
    }));
    if (opened) opened.location.href = url;
    else window.location.href = url;
  };

  const mark = (value: string) => act(() => api.post(`/api/scheduler/bookings/${booking.id}/attendance`, { value }));
  const remind = (done: boolean) => act(() => api.post(`/api/scheduler/bookings/${booking.id}/reminded`, { done }));

  return (
    <Modal title={`${booking.service_name} with ${booking.customer_name}`} onClose={onClose}>
      <div className="facts">
        <div><div className="stat-label">When</div>{dayLabel(booking.local_date, true)}, {booking.start_time} to {booking.end_time}</div>
        <div><div className="stat-label">With</div>{booking.staff_name}</div>
        <div><div className="stat-label">Where</div>{LOCATIONS[booking.location_type]}{booking.location_detail ? `: ${booking.location_detail}` : ''}</div>
        <div><div className="stat-label">Status</div>
          <span className={`badge ${live ? 'paid' : 'void'}`}>{live ? 'booked' : 'cancelled'}</span>
          {!live && booking.cancelled_by_visitor ? ' by the customer' : ''}
          {live && booking.attendance && <> <span className={`badge ${booking.attendance === 'attended' ? 'paid' : 'failed'}`}>{booking.attendance === 'attended' ? 'attended' : 'no-show'}</span></>}
          {booking.visitor_moves > 0 && <div className="muted">Moved by the customer {booking.visitor_moves === 1 ? 'once' : `${booking.visitor_moves} times`}</div>}
        </div>
        {booking.session_key && (
          <div><div className="stat-label">Group session</div>{booking.seats_taken} of {booking.capacity} places taken</div>
        )}
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
      <AnswerList answers={booking.answers} />
      {booking.repeat_group && <p className="muted">This booking repeats.</p>}
      {live && data.can_edit && booking.has_started && (
        <div className="row-actions" style={{ marginTop: 8 }}>
          <span className="stat-label">Did they come?</span>
          <button className={booking.attendance === 'attended' ? 'primary' : ''} onClick={() => mark(booking.attendance === 'attended' ? '' : 'attended')}>Attended</button>
          <button className={booking.attendance === 'no_show' ? 'danger' : ''} onClick={() => mark(booking.attendance === 'no_show' ? '' : 'no_show')}>No-show</button>
        </div>
      )}
      {live && data.can_edit && !booking.has_started && (
        <label className="check">
          <input type="checkbox" checked={!!booking.reminded_at} onChange={(e) => remind(e.target.checked)} /> Reminded them
        </label>
      )}
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
            <button className="primary" disabled={busy || !form.time} onClick={() => move(false)}>Move booking</button>
            <button type="button" onClick={() => setMoving(false)}>Back</button>
          </div>
          {away && <AwayWarning message={away} action="Move" onConfirm={() => move(true)} onBack={() => { setAway(''); setForm({ ...form, time: '' }); }} />}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        {live && data.can_edit && !moving && <button className="primary" onClick={() => setMoving(true)}>Reschedule</button>}
        {live && !booking.has_started && (
          <button type="button" onClick={sendWhatsApp}
            title={booking.customer_phone ? 'Opens WhatsApp with a reminder ready to send' : 'No phone number on this booking: WhatsApp will ask who to send it to'}>
            Send on WhatsApp
          </button>
        )}
        {live && data.can_edit && <button className="danger" disabled={busy} onClick={cancel}>Cancel booking</button>}
        {live && data.can_edit && booking.repeat_group && <button className="danger" disabled={busy} onClick={cancelRepeats}>Cancel this and later repeats</button>}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

// Save a visitor's booking in their own calendar: a file for any calendar app, or Google Calendar.
// Used on the public pages, which reach the gateway without signing in.
export function AddToCalendar({ booking, token }: { booking: any; token: string }) {
  if (booking.status !== 'booked') return null;
  const title = `${booking.service} with ${booking.with} (${booking.company})`;
  const where = booking.room_url || booking.location_detail || LOCATIONS[booking.location_type];
  const details = booking.room_url ? `Video link: ${booking.room_url}` : '';
  return (
    <p className="row-actions">
      <a className="button" href={`${process.env.NEXT_PUBLIC_API_BASE_URL}/api/book/cancel/${encodeURIComponent(token)}/ics`}>Add to calendar (.ics)</a>
      <a className="button" href={googleCalendarLink(title, booking.starts_at, booking.ends_at, details, where)} target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>
    </p>
  );
}

export const priceText =(price: any, currency?: string) =>
  price === null || price === undefined || price === '' ? 'Free' : money(price, currency || undefined);
