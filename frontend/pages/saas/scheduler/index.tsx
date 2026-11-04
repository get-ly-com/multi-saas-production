import Link from 'next/link';
import { useRouter } from 'next/router';
import { CSSProperties, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import { BookingDetails, NewBooking } from '@/components/SchedulerForms';
import SchedulerNav, { LOCATIONS, addDays, dayLabel, weekStart } from '@/components/SchedulerNav';
import Skeleton, { SkeletonStats } from '@/components/Skeleton';
import { api } from '@/lib/api';
import s from '@/styles/scheduler.module.css';

export default function Scheduler() {
  return <AppShell><Bookings /></AppShell>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function Bookings() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [calendar, setCalendar] = useState<any>(null);
  const [view, setView] = useState<'week' | 'day'>('week');
  const [day, setDay] = useState('');
  const [staff, setStaff] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const loadSetup = async () => {
    try {
      const [overview, services] = await Promise.all([api.get('/api/scheduler/overview'), api.get('/api/scheduler/services')]);
      setData({ ...overview, services });
      const asked = typeof router.query.date === 'string' && DATE.test(router.query.date) ? router.query.date : '';
      setDay((current) => current || asked || overview.today);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (router.isReady) loadSetup();
  }, [router.isReady]);

  // A link from an alert can point at another day while this page is open
  useEffect(() => {
    const asked = router.query.date;
    if (typeof asked === 'string' && DATE.test(asked)) setDay(asked);
  }, [router.query.date]);

  const from = view === 'week' && day ? weekStart(day) : day;
  const days = view === 'week' ? 7 : 1;

  const load = async () => {
    if (!from) return;
    const mine = ++latest.current;
    try {
      const params = new URLSearchParams({ from, days: String(days), cancelled: String(cancelled) });
      if (staff) params.set('staff', staff);
      const result = await api.get(`/api/scheduler/calendar?${params}`);
      if (mine !== latest.current) return;
      setCalendar(result);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [from, days, staff, cancelled]);

  if (!data || !calendar) {
    return (
      <div className="stack">
        <SchedulerNav />
        {error ? <p className="error">{error}</p> : (
          <div className="stack" role="status" aria-label="Loading bookings">
            <div className="page-head"><Skeleton width={160} height={28} /><Skeleton width={128} height={34} /></div>
            <SkeletonStats count={3} />
            <div className="card"><Skeleton height={36} width="50%" /><Skeleton height={420} radius={12} style={{ marginTop: 14 }} /></div>
          </div>
        )}
      </div>
    );
  }

  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const itemsOn = (date: string) => [
    ...calendar.bookings.filter((row: any) => row.local_date === date).map((row: any) => ({ ...row, kind: 'booking' })),
    ...calendar.meetings.filter((row: any) => row.local_date === date).map((row: any) => ({ ...row, kind: 'meeting' }))
  ].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const step = view === 'week' ? 7 : 1;
  const nothingSetUp = !data.services.length || !data.staff.some((row: any) => row.set_up);
  const colours = serviceColours(data.services);
  const shownServices = data.services.filter((row: any) => calendar.bookings.some((b: any) => b.service_id === row.id));
  const booked = calendar.bookings.filter((row: any) => row.status === 'booked').length;

  return (
    <div className="stack">
      <SchedulerNav />
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <p className="muted">Everything booked with your team, in {calendar.time_zone} time.</p>
        </div>
        {data.can_edit && <button className="primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} />New booking</button>}
      </div>

      {error && <p className="error">{error}</p>}
      {nothingSetUp && (
        <p className="notice">
          To start taking bookings, {!data.services.length ? <Link href="/saas/scheduler/services">add a service</Link> : 'add a service'} and{' '}
          <Link href="/saas/scheduler/hours">set opening hours</Link>. Then share your booking link from <Link href="/saas/scheduler/settings">Settings</Link>.
        </p>
      )}

      <div className="stats">
        <div className="card"><div className="stat-label">Booked in the next 7 days</div><div className="stat-value">{data.next_7_days}</div></div>
        <div className="card"><div className="stat-label">{view === 'week' ? 'Booked this week' : 'Booked this day'}</div><div className="stat-value">{booked}</div></div>
        <div className="card"><div className="stat-label">Video meetings</div><div className="stat-value">{calendar.meetings.length}</div></div>
      </div>

      <div className="card">
        <div className={s.toolbar}>
          <div className={s.nav}>
            <button className="icon-button" onClick={() => setDay(addDays(day, -step))} aria-label={view === 'week' ? 'Previous week' : 'Previous day'}><Icon name="chevron-left" size={18} /></button>
            <button className="small" onClick={() => setDay(calendar.today)}>Today</button>
            <button className="icon-button" onClick={() => setDay(addDays(day, step))} aria-label={view === 'week' ? 'Next week' : 'Next day'}><Icon name="chevron-right" size={18} /></button>
            <span className={s.range}>{view === 'week' ? `${dayLabel(from)} to ${dayLabel(addDays(from, 6))}` : dayLabel(day, true)}</span>
          </div>
          <div className={s.filters}>
            <div className={s.segment} role="group" aria-label="View">
              <button type="button" className={view === 'week' ? s.on : ''} aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</button>
              <button type="button" className={view === 'day' ? s.on : ''} aria-pressed={view === 'day'} onClick={() => setView('day')}>Day</button>
            </div>
            <select aria-label="Whose bookings" value={staff} onChange={(e) => setStaff(e.target.value)}>
              <option value="">Everyone</option>
              {data.staff.filter((row: any) => row.set_up).map((row: any) => (
                <option key={row.user_id} value={row.user_id}>{row.user_id === data.me ? `${row.display_name} (me)` : row.display_name}</option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} /> Show cancelled
            </label>
          </div>
        </div>

        {(shownServices.length > 0 || calendar.meetings.length > 0) && (
          <ul className={s.legend} aria-label="Colours">
            {shownServices.map((row: any) => <li key={row.id} style={{ '--svc': colours[row.id] } as CSSProperties}><i />{row.name}</li>)}
            {calendar.meetings.length > 0 && <li style={{ '--svc': 'var(--good)' } as CSSProperties}><i />Video meeting</li>}
          </ul>
        )}

        <TimeGrid
          dates={dates}
          today={calendar.today}
          timeZone={calendar.time_zone}
          itemsOn={itemsOn}
          colours={colours}
          onOpen={setOpen}
          onPickDay={view === 'week' ? (date) => { setDay(date); setView('day'); } : undefined}
        />

        {view === 'day' && (
          itemsOn(day).length === 0 ? (
            <EmptyState compact icon="scheduler" title="Nothing booked on this day"
              line={data.can_edit ? 'A free day. Add a booking, or share your booking link so customers can pick a time.' : 'A free day for the team.'}
              action={data.can_edit ? { label: 'New booking', onClick: () => setAdding(true) } : undefined} />
          ) : (
            <ul className={s.agenda} aria-label="Bookings on this day">
              {itemsOn(day).map((item) => item.kind === 'booking' ? (
                <li key={`b-${item.id}`} className={`${s.agendaRow} ${item.status === 'cancelled' ? s.cancelled : ''}`} style={{ '--svc': colours[item.service_id] } as CSSProperties}>
                  <span className={s.agendaTime}>{item.start_time}<small>to {item.end_time}</small></span>
                  <span className={s.agendaText}>
                    <strong>
                      {item.customer_name}
                      {item.status === 'cancelled' && <span className="badge cancelled">cancelled</span>}
                      {item.attendance && <span className={`badge ${item.attendance === 'attended' ? 'attended' : 'no_show'}`}>{item.attendance === 'attended' ? 'attended' : 'no-show'}</span>}
                    </strong>
                    <span>{item.service_name} with {item.staff_name} · {LOCATIONS[item.location_type]}{item.session_key ? ` · group, ${item.seats_taken} of ${item.capacity} places` : ''}</span>
                  </span>
                  <span className={s.agendaActions}>
                    {item.room_url && <a className="button small primary always" href={item.room_url} target="_blank" rel="noopener noreferrer"><Icon name="meetings" size={14} />Join</a>}
                    <button type="button" className="small always" onClick={() => setOpen(item)}>Open</button>
                  </span>
                </li>
              ) : (
                <li key={`m-${item.id}`} className={s.agendaRow} style={{ '--svc': 'var(--good)' } as CSSProperties}>
                  <span className={s.agendaTime}>{item.start_time}<small>{item.duration_minutes ? `${item.duration_minutes} min` : ''}</small></span>
                  <span className={s.agendaText}><strong>{item.title}</strong><span>Video meeting with {item.host_name}</span></span>
                  <span className={s.agendaActions}><a className="button small primary always" href={item.room_url} target="_blank" rel="noopener noreferrer"><Icon name="meetings" size={14} />Join</a></span>
                </li>
              ))}
            </ul>
          )
        )}

        <p className={s.foot}>
          <span>Times are in {calendar.time_zone}.</span>
          <span>Video meetings from <Link href="/saas/video">Meetings</Link> show here too.</span>
        </p>
      </div>

      {adding && <NewBooking data={data} date={day < calendar.today ? calendar.today : day} onClose={() => setAdding(false)}
        onSaved={(booking) => { setDay(booking.local_date); load(); loadSetup(); }} />}
      {open && <BookingDetails booking={open} data={data} onClose={() => setOpen(null)} onSaved={() => { load(); loadSetup(); }} />}
    </div>
  );
}

// One colour per service, steady from week to week, taken from the suite's own hues
const HUES = ['var(--stage-2)', 'var(--stage-4)', 'var(--stage-3)', 'var(--stage-1)', 'var(--series-2)', 'var(--stage-5)'];
const serviceColours = (services: any[]) =>
  Object.fromEntries(services.map((row: any, n: number) => [row.id, HUES[n % HUES.length]])) as Record<string, string>;

const minutesOf = (time: string) => {
  const [h, m] = String(time || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// What time it is now in the company's time zone, ticking each minute
function useNow(timeZone: string) {
  const [now, setNow] = useState<{ date: string; minutes: number } | null>(null);
  useEffect(() => {
    const read = () => {
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date()).map((part) => [part.type, part.value]));
        setNow({ date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) });
      } catch {
        setNow(null);
      }
    };
    read();
    const timer = setInterval(read, 60000);
    return () => clearInterval(timer);
  }, [timeZone]);
  return now;
}

const HOUR = 52;

function TimeGrid({ dates, today, timeZone, itemsOn, colours, onOpen, onPickDay }: {
  dates: string[]; today: string; timeZone: string; itemsOn: (date: string) => any[]; colours: Record<string, string>;
  onOpen: (item: any) => void; onPickDay?: (date: string) => void;
}) {
  const now = useNow(timeZone);
  const scroller = useRef<HTMLDivElement>(null);

  const placed = dates.map((date) => {
    const items = itemsOn(date).map((item) => {
      const start = minutesOf(item.start_time);
      let end = item.end_time ? minutesOf(item.end_time) : start + Number(item.duration_minutes || 30);
      if (end <= start) end = 24 * 60;
      return { item, start, end, lane: 0, lanes: 1 };
    });
    // Bookings at the same time sit side by side
    const groups: (typeof items)[] = [];
    items.forEach((entry) => {
      const group = groups[groups.length - 1];
      if (group && entry.start < Math.max(...group.map((g) => g.end))) group.push(entry);
      else groups.push([entry]);
    });
    groups.forEach((group) => {
      const laneEnds: number[] = [];
      group.forEach((entry) => {
        let lane = laneEnds.findIndex((end) => end <= entry.start);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(entry.end); } else laneEnds[lane] = entry.end;
        entry.lane = lane;
      });
      group.forEach((entry) => { entry.lanes = laneEnds.length; });
    });
    return { date, items };
  });

  const all = placed.flatMap((entry) => entry.items);
  const first = Math.min(8, ...all.map((entry) => Math.floor(entry.start / 60)));
  const last = Math.min(24, Math.max(18, ...all.map((entry) => Math.ceil(entry.end / 60))));
  const hours = Array.from({ length: last - first }, (_, n) => first + n);
  const y = (minutes: number) => ((minutes - first * 60) / 60) * HOUR;
  const columns = `56px repeat(${dates.length}, minmax(0, 1fr))`;
  const showNow = now && dates.includes(now.date) && now.minutes >= first * 60 && now.minutes <= last * 60;

  // Open the view near the first booking, or near now
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const target = Math.min(...all.map((entry) => entry.start), showNow && now ? now.minutes : Infinity);
    if (Number.isFinite(target)) box.scrollTop = Math.max(0, y(target) - HOUR);
  }, [dates.join(), all.length]);

  return (
    <div className={s.scroller} ref={scroller} style={{ maxHeight: 640, overflowY: 'auto' }}>
      <div className={`${s.grid} ${dates.length === 1 ? s.single : ''}`}>
        <div className={s.heads} style={{ gridTemplateColumns: columns }}>
          <span className={s.corner} />
          {dates.map((date) => {
            const label = new Date(`${date}T00:00:00Z`);
            const booked = itemsOn(date).filter((item) => item.status !== 'cancelled').length;
            const inner = (
              <>
                {label.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' })}
                <strong>{label.getUTCDate()}</strong>
                <small>{booked ? `${booked} booked` : 'Free'}</small>
              </>
            );
            return onPickDay ? (
              <button key={date} type="button" className={`${s.dayHead} ${date === today ? s.isToday : ''}`}
                onClick={() => onPickDay(date)} aria-label={`${dayLabel(date, true)}, ${booked ? `${booked} booked` : 'free'}. Open this day`}>
                {inner}
              </button>
            ) : (
              <div key={date} className={`${s.dayHead} ${date === today ? s.isToday : ''}`}>{inner}</div>
            );
          })}
        </div>
        <div className={s.body} style={{ gridTemplateColumns: columns, height: hours.length * HOUR, ['--hour' as any]: `${HOUR}px` }}>
          <div className={s.gutter} aria-hidden="true">
            {hours.slice(1).map((hour) => (
              <span key={hour} className={s.hourLabel} style={{ top: (hour - first) * HOUR }}>{clock(hour * 60)}</span>
            ))}
          </div>
          {placed.map(({ date, items }) => (
            <div key={date} className={`${s.col} ${date === today ? s.isToday : date < today ? s.past : ''}`}>
              {items.map(({ item, start, end, lane, lanes }) => {
                const height = Math.max(20, y(end) - y(start) - 2);
                const style = {
                  top: y(start) + 1, height,
                  left: `calc(${(lane / lanes) * 100}% + 3px)`, width: `calc(${100 / lanes}% - 6px)`,
                  '--svc': item.kind === 'meeting' ? 'var(--good)' : colours[item.service_id] || 'var(--accent)'
                } as CSSProperties;
                const short = height < 40;
                if (item.kind === 'meeting') {
                  return (
                    <a key={`m-${item.id}`} className={`${s.block} ${s.meeting} ${short ? s.short : ''}`} style={style}
                      href={item.room_url} target="_blank" rel="noopener noreferrer" title={`${item.start_time} ${item.title}, video meeting with ${item.host_name}`}>
                      <time>{item.start_time}</time>
                      <strong>{item.title}</strong>
                      {!short && <span>Video meeting · {item.host_name}</span>}
                    </a>
                  );
                }
                return (
                  <a key={`b-${item.id}`} href="#"
                    className={`${s.block} ${short ? s.short : ''} ${item.status === 'cancelled' ? s.cancelled : ''} ${item.attendance === 'no_show' ? s.noShow : ''}`}
                    style={style} onClick={(e) => { e.preventDefault(); onOpen(item); }}
                    title={`${item.start_time} to ${item.end_time}, ${item.customer_name}, ${item.service_name} with ${item.staff_name}`}>
                    <time>{item.start_time} to {item.end_time}</time>
                    <strong>{item.customer_name}</strong>
                    {!short && <span>{item.service_name} · {item.staff_name}{item.session_key ? ` · ${item.seats_taken}/${item.capacity}` : ''}{item.attendance === 'no_show' ? ' · no-show' : ''}{item.status === 'cancelled' ? ' · cancelled' : ''}</span>}
                  </a>
                );
              })}
              {showNow && now && now.date === date && (
                <span className={s.now} style={{ top: y(now.minutes) }} role="img" aria-label={`Now, ${clock(now.minutes)}`} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
