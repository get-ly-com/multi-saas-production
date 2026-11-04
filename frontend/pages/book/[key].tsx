import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { celebrate } from '@/components/Celebrate';
import Icon from '@/components/Icon';
import { AddToCalendar, Answers } from '@/components/SchedulerForms';
import { LOCATIONS, addDays, dayLabel, placesText } from '@/components/SchedulerNav';
import Skeleton from '@/components/Skeleton';
import { money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import p from '@/styles/public.module.css';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
const WINDOW = 7;

const getJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || (response.status === 429 ? 'Too many tries. Please wait a minute and try again.' : 'Something went wrong. Please try again.'));
  return result;
};

const LOCATION_ICONS: Record<string, string> = { in_person: 'company', phone: 'chat', video: 'meetings' };
const initial = (name: string) => (name || '?').trim().charAt(0).toUpperCase();

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
  const [picked, setPicked] = useState('');
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '', website: '' });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [done, setDone] = useState<any>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [cancelLink, setCancelLink] = useState('');
  const tick = useRef<HTMLDivElement>(null);

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
    // A booking made is a real win for the visitor too: one gentle burst
    if (done?.token) setTimeout(() => celebrate({ from: tick.current, pieces: 60 }), 260);
  }, [done]);

  const byDay: Record<string, any[]> = {};
  for (const row of slots || []) (byDay[row.date] = byDay[row.date] || []).push(row);
  const windowDays = from ? Array.from({ length: WINDOW }, (_, n) => addDays(from, n)) : [];

  // Pick the first day with free times whenever a new set of times arrives
  useEffect(() => {
    if (!slots) return setPicked('');
    setPicked((current) => (current && byDay[current] ? current : Object.keys(byDay).sort()[0] || ''));
  }, [slots]);

  const chooseService = (id: string) => {
    setServiceId(id);
    setAnswers({});
    setStaffId('');
    setSlot(null);
    setError('');
  };

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setSending(true);
      setError('');
      try {
        const result = await getJson(`/api/book/${encodeURIComponent(key as string)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...form, answers, service_id: service.id, staff_id: staffId || null, start: slot.start, campaign })
        });
        setDone(result);
      } catch (err: any) {
        setError(err.message);
        // The time may have just gone, so show fresh times
        if (/no longer free|already booked|session is full|away on leave|closed that day/i.test(err.message)) {
          setSlot(null);
          setSlots(null);
          const params = new URLSearchParams({ service: service.id, from, days: String(WINDOW) });
          if (staffId) params.set('staff', staffId);
          getJson(`/api/book/${encodeURIComponent(key as string)}/slots?${params}`).then(setSlots).catch(() => setSlots([]));
        }
      } finally {
        setSending(false);
      }
    });
  };

  const stepNames = [...(info?.services.length > 1 ? ['Service'] : []), 'Date and time', 'Your details'];
  const stepNow = !service ? 0 : !slot ? stepNames.length - 2 : stepNames.length - 1;
  const priceOf = (row: any) => (row.price !== null && row.price !== undefined ? money(row.price, info.currency || 'USD') : '');

  return (
    <div className={p.page}>
      <Head><title>{info ? `Book with ${info.company}` : 'Book a time'}</title></Head>
      <div className={done ? p.narrow : p.wrap}>
        {closed && (
          <div className={`${p.panel} ${p.message}`}>
            <div className="empty-state">
              <div className="empty-art" aria-hidden="true"><span className="empty-ring" /><Icon name="scheduler" size={24} /></div>
              <h3>This booking page is not available</h3>
              <p>The link may have changed. Please ask the company for a new one.</p>
            </div>
          </div>
        )}

        {!info && !closed && (
          <div className={p.panel} role="status" aria-label="Loading">
            <div className={p.split}>
              <div className={p.side}><Skeleton width={40} height={40} radius={12} /><Skeleton width="70%" height={26} /><Skeleton width="90%" /><Skeleton width="60%" /></div>
              <div className={p.main}><Skeleton width="40%" height={20} /><Skeleton height={72} radius={12} /><Skeleton height={72} radius={12} /></div>
            </div>
          </div>
        )}

        {done && (
          <div className={p.panel}>
            {done.token ? (
              <div className={p.done}>
                <div className={p.tick} ref={tick} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
                <h1>You&apos;re booked</h1>
                <p>All set{done.name ? `, ${String(done.name).split(' ')[0]}` : ''}. Here are the details.</p>
                <dl className={p.summary}>
                  <div><dt>What</dt><dd><strong>{done.service}</strong> with {done.with}</dd></div>
                  <div><dt>When</dt><dd>{dayLabel(done.local_date, true)}, {done.start_time} to {done.end_time}<br /><span className="muted">{done.time_zone}</span></dd></div>
                  <div><dt>Where</dt><dd>{LOCATIONS[done.location_type]}{done.location_detail ? `: ${done.location_detail}` : ''}</dd></div>
                  {done.room_url && (
                    <div><dt>Video link</dt><dd><a href={done.room_url} target="_blank" rel="noopener noreferrer">{done.room_url}</a><br />
                      <span className="muted">Calls run on Jitsi Meet, a free video service. Open the link at the time of your booking.</span></dd></div>
                  )}
                </dl>
                <AddToCalendar booking={done} token={done.token} />
                <div className={p.keep}>
                  <p><strong>Save this link.</strong> We don&apos;t send emails, so this is how you get back to your booking to change the time or cancel it:</p>
                  <p><Link href={`/book/cancel/${done.token}`}>{cancelLink || 'Manage your booking'}</Link></p>
                </div>
              </div>
            ) : <div className={p.done}><h1>Thank you</h1></div>}
          </div>
        )}

        {info && !done && (
          <div className={p.panel}>
            <div className={p.split}>
              <aside className={p.side}>
                <div className={p.logo} aria-hidden="true">{initial(info.company)}</div>
                <div>
                  <p className="muted small" style={{ margin: 0 }}>{info.company}</p>
                  <h1>{service ? service.name : 'Book a time'}</h1>
                </div>
                {info.welcome && !service && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{info.welcome}</p>}
                {service?.description && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{service.description}</p>}
                {service && (
                  <ul className={p.facts}>
                    <li><Icon name="clock" size={16} /><span><strong>{service.duration_minutes} min</strong></span></li>
                    <li><Icon name={LOCATION_ICONS[service.location_type] || 'company'} size={16} /><span>{LOCATIONS[service.location_type]}</span></li>
                    {service.capacity > 1 && <li><Icon name="team" size={16} /><span>Group session</span></li>}
                    {priceOf(service) && <li><Icon name="money" size={16} /><span>{priceOf(service)}</span></li>}
                    {slot && <li><Icon name="scheduler" size={16} /><span><strong>{dayLabel(slot.date, true)}</strong><br />{slot.time}</span></li>}
                    <li><Icon name="monitor" size={16} /><span>Times in {info.time_zone}</span></li>
                  </ul>
                )}
                {service && info.services.length > 1 && (
                  <button type="button" className="ghost small" style={{ justifySelf: 'start' }} onClick={() => chooseService('')}>
                    <Icon name="chevron-left" size={14} />Other services
                  </button>
                )}
              </aside>

              <section className={p.main}>
                {info.services.length > 0 && (
                  <ol className={p.steps} aria-label="Steps">
                    {stepNames.map((name, n) => (
                      <li key={name} className={n === stepNow ? p.now : n < stepNow ? p.past : ''} aria-current={n === stepNow ? 'step' : undefined}>
                        <i>{n < stepNow ? <Icon name="check" size={12} strokeWidth={2.5} /> : n + 1}</i>{name}
                      </li>
                    ))}
                  </ol>
                )}

                {info.services.length === 0 && (
                  <div className="empty-state is-compact">
                    <div className="empty-art" aria-hidden="true"><span className="empty-ring" /><Icon name="scheduler" size={20} /></div>
                    <h3>Nothing to book right now</h3>
                    <p>Please check back soon.</p>
                  </div>
                )}

                {!service && info.services.length > 1 && (
                  <>
                    <h2>What would you like to book?</h2>
                    <div className={p.services}>
                      {info.services.map((row: any) => (
                        <button key={row.id} type="button" className={p.service} onClick={() => chooseService(row.id)}>
                          <strong>{row.name}</strong>
                          <span>{row.duration_minutes} min · {LOCATIONS[row.location_type]}{row.capacity > 1 ? ' · group session' : ''}{priceOf(row) ? ` · ${priceOf(row)}` : ''}</span>
                          {row.description && <small>{row.description}</small>}
                          <Icon name="chevron-right" size={18} />
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {service && service.staff.length === 0 && <p className="empty">Nobody is taking bookings for this right now.</p>}

                {service && service.staff.length > 0 && !slot && (
                  <>
                    <h2>Pick a day and time</h2>
                    {service.staff.length > 1 && (
                      <label>With
                        <select value={staffId} onChange={(e) => { setStaffId(e.target.value); setSlot(null); }}>
                          <option value="">Anyone</option>
                          {service.staff.map((row: any) => <option key={row.id} value={row.id}>{row.name}</option>)}
                        </select>
                      </label>
                    )}
                    <div className={p.weekHead}>
                      <strong>{windowDays.length ? new Date(`${from}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }) : ''}</strong>
                      <div className="row-actions">
                        <button type="button" className="icon-button" aria-label="Earlier days" disabled={from <= info.today}
                          onClick={() => setFrom(addDays(from, -WINDOW) < info.today ? info.today : addDays(from, -WINDOW))}><Icon name="chevron-left" size={18} /></button>
                        <button type="button" className="icon-button" aria-label="Later days" disabled={addDays(from, WINDOW) > lastDay}
                          onClick={() => setFrom(addDays(from, WINDOW))}><Icon name="chevron-right" size={18} /></button>
                      </div>
                    </div>
                    <div className={p.dates} role="group" aria-label="Days">
                      {windowDays.map((date) => {
                        const label = new Date(`${date}T00:00:00Z`);
                        const free = (byDay[date] || []).length;
                        return (
                          <button key={date} type="button" className={`${p.date} ${picked === date ? p.picked : ''}`}
                            disabled={slots === null || !free || date > lastDay} aria-pressed={picked === date}
                            aria-label={`${dayLabel(date, true)}, ${free ? `${free} free times` : 'no free times'}`}
                            onClick={() => setPicked(date)}>
                            <small>{label.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' })}</small>
                            <strong>{label.getUTCDate()}</strong>
                            <em>{slots === null ? ' ' : free ? `${free} free` : 'Full'}</em>
                          </button>
                        );
                      })}
                    </div>

                    {slots === null && (
                      <div className={p.times} aria-busy="true">{Array.from({ length: 8 }, (_, n) => <Skeleton key={n} height={42} radius={8} />)}</div>
                    )}
                    {slots?.length === 0 && (
                      <p className="muted" style={{ margin: 0 }}>No free times in these days. Try the next week with the arrow above.</p>
                    )}
                    {picked && byDay[picked] && (
                      <div>
                        <p className="muted small" style={{ marginBottom: 8 }}>{dayLabel(picked, true)}</p>
                        <div className={p.times}>
                          {byDay[picked].map((row) => (
                            <button type="button" className={p.time} key={row.start} onClick={() => setSlot(row)}>
                              {row.time}{row.seats_left ? <small>{placesText(row.seats_left)}</small> : null}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {slot && (
                  <form onSubmit={submit} className={p.form}>
                    <h2>Your details</h2>
                    <div className={p.chosen}>
                      <span>
                        <strong>{dayLabel(slot.date, true)} at {slot.time}</strong>
                        <span className="muted small">{service.name}, {info.time_zone}{slot.seats_left ? `. Group session, ${placesText(slot.seats_left)}` : ''}</span>
                      </span>
                      <button type="button" className="small" onClick={() => setSlot(null)}>Change time</button>
                    </div>
                    <div className="form-grid">
                      <label>Your name<input required maxLength={200} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                      <label>Email<input type="email" required maxLength={254} autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
                    </div>
                    <label>Phone{service.location_type === 'phone' ? '' : ' (optional)'}
                      <input required={service.location_type === 'phone'} maxLength={40} autoComplete="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                    </label>
                    <Answers online questions={service.questions || []} value={answers} onChange={setAnswers} />
                    <label>Anything else we should know? (optional)<textarea rows={3} maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
                    <label className="trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></label>
                    {service.location_type === 'video' && <p className="muted small" style={{ margin: 0 }}>You&apos;ll get a video link after booking. Calls run on Jitsi Meet, a free video service.</p>}
                    {error && <p className="error">{error}</p>}
                    <button className="primary" disabled={busy || sending}>{sending ? 'Booking…' : `Book ${slot.time} on ${dayLabel(slot.date)}`}</button>
                  </form>
                )}
                {!slot && error && <p className="error">{error}</p>}
              </section>
            </div>
          </div>
        )}

        {(info || done) && (
          <p className={p.foot}><Icon name="paid" size={14} />Booking with {info?.company || done?.company || 'the company'}</p>
        )}
      </div>
    </div>
  );
}
