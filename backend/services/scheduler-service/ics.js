// A small iCalendar (.ics) reader that turns a person's calendar into busy times.
// Only start and end times leave this file (and the event UID, to spot our own bookings coming
// back): never titles, places or people.
//
// Handles: DTSTART/DTEND with TZID, UTC ('Z') and floating times, all-day dates, DURATION,
// TRANSP:TRANSPARENT and "free" Outlook events (skipped), STATUS:CANCELLED (skipped),
// RRULE with FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, WKST,
// plus EXDATE, RDATE and moved or cancelled single occurrences (RECURRENCE-ID).
// Rules with other parts (BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR, ...) or other frequencies
// only block their first occurrence.

const DAY_MS = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_EVENTS = 20000;
const MAX_STEPS = 50000;
const MAX_OUT = 5000;

// Outlook writes Windows time zone names
const WINDOWS_ZONES = {
  'Dateline Standard Time': 'Etc/GMT+12', 'UTC-11': 'Etc/GMT+11', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage', 'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix', 'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago', 'Canada Central Standard Time': 'America/Regina',
  'Central America Standard Time': 'America/Guatemala', 'Mexico Standard Time': 'America/Mexico_City',
  'Central Standard Time (Mexico)': 'America/Mexico_City', 'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis', 'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax', 'Venezuela Standard Time': 'America/Caracas',
  'SA Western Standard Time': 'America/La_Paz', 'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Buenos_Aires',
  'SA Eastern Standard Time': 'America/Cayenne', 'Pacific SA Standard Time': 'America/Santiago',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC', 'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik', 'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest', 'FLE Standard Time': 'Europe/Kiev', 'E. Europe Standard Time': 'Europe/Chisinau',
  'Egypt Standard Time': 'Africa/Cairo', 'South Africa Standard Time': 'Africa/Johannesburg',
  'Israel Standard Time': 'Asia/Jerusalem', 'Jordan Standard Time': 'Asia/Amman', 'Turkey Standard Time': 'Europe/Istanbul',
  'Arabic Standard Time': 'Asia/Baghdad', 'Arab Standard Time': 'Asia/Riyadh', 'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi', 'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai',
  'Azerbaijan Standard Time': 'Asia/Baku', 'Afghanistan Standard Time': 'Asia/Kabul', 'Pakistan Standard Time': 'Asia/Karachi',
  'West Asia Standard Time': 'Asia/Tashkent', 'India Standard Time': 'Asia/Calcutta', 'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Katmandu', 'Central Asia Standard Time': 'Asia/Almaty', 'Bangladesh Standard Time': 'Asia/Dhaka',
  'Myanmar Standard Time': 'Asia/Rangoon', 'SE Asia Standard Time': 'Asia/Bangkok', 'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore', 'Taipei Standard Time': 'Asia/Taipei', 'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin', 'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'Tasmania Standard Time': 'Australia/Hobart',
  'West Pacific Standard Time': 'Pacific/Port_Moresby', 'New Zealand Standard Time': 'Pacific/Auckland',
  'Fiji Standard Time': 'Pacific/Fiji', 'Tonga Standard Time': 'Pacific/Tongatapu', 'Morocco Standard Time': 'Africa/Casablanca'
};

// ---------------------------------------------------------------- Time zones
const formatters = new Map();
const validZone = (zone) => {
  if (!zone) return false;
  if (formatters.has(zone)) return true;
  try {
    formatters.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    }));
    return true;
  } catch {
    return false;
  }
};

// Milliseconds the zone is ahead of UTC at a moment
const zoneOffset = (zone, ms) => {
  const parts = {};
  for (const part of formatters.get(zone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
};

// Wall-clock fields (as if UTC) in a zone -> real UTC milliseconds. A time skipped by a DST
// change moves forward; a repeated one takes the first.
const zonedToUtc = (wall, zone) => {
  const first = zoneOffset(zone, wall);
  let guess = wall - first;
  const second = zoneOffset(zone, guess);
  if (second !== first) {
    const retry = wall - second;
    guess = zoneOffset(zone, retry) === second ? retry : Math.max(guess, retry);
  }
  return guess;
};

// VTIMEZONE fallback for names Intl doesn't know: the yearly STANDARD/DAYLIGHT rules
const offsetValue = (text) => {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(text || '');
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] * 60 + +m[3]) * 60 + +(m[4] || 0)) * 1000;
};

const nthWeekday = (year, month, n, weekday) => {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= daysInMonth(year, month) ? day : null;
  }
  const lastDay = daysInMonth(year, month);
  const last = new Date(Date.UTC(year, month, lastDay)).getUTCDay();
  const day = lastDay - ((last - weekday + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? day : null;
};

const vtimezoneOffset = (tz, wall) => {
  // Find the most recent transition (in wall time) before this moment
  let best = null;
  const year = new Date(wall).getUTCFullYear();
  for (const part of tz.parts) {
    const to = offsetValue(part.to);
    if (to === null || part.start === null) continue;
    const startFields = new Date(part.start);
    const candidates = [];
    if (part.rule && part.rule.FREQ === 'YEARLY' && part.rule.BYMONTH && part.rule.BYDAY) {
      const month = Number(part.rule.BYMONTH) - 1;
      const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part.rule.BYDAY.split(',')[0]);
      if (m) {
        for (const y of [year - 1, year]) {
          const day = nthWeekday(y, month, Number(m[1] || 1), WEEKDAYS.indexOf(m[2]));
          if (day) {
            const at = Date.UTC(y, month, day, startFields.getUTCHours(), startFields.getUTCMinutes());
            if (at >= part.start) candidates.push(at);
          }
        }
      }
    } else {
      candidates.push(part.start);
    }
    for (const at of candidates) {
      if (at <= wall && (!best || at > best.at)) best = { at, to };
    }
  }
  if (best) return best.to;
  const any = tz.parts.find((part) => offsetValue(part.to) !== null);
  return any ? offsetValue(any.to) : 0;
};

// ---------------------------------------------------------------- Reading lines
const unfold = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');

// NAME;PARAM=VALUE;PARAM="quoted:value":VALUE
const parseLine = (line) => {
  let i = 0;
  let quoted = false;
  let nameEnd = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ';' && nameEnd < 0) nameEnd = i;
    else if (!quoted && ch === ':') break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const pieces = [];
  let current = '';
  quoted = false;
  for (const ch of head) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ';' && !quoted) { pieces.push(current); current = ''; continue; }
    current += ch;
  }
  pieces.push(current);
  const params = {};
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf('=');
    if (eq > 0) params[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1);
  }
  return { name: pieces[0].toUpperCase(), params, value };
};

// ---------------------------------------------------------------- Dates
// A value in a property -> { wall: ms as if UTC, kind: 'utc' | 'zoned' | 'floating' | 'date', zone }
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;
const readDate = (value, params) => {
  const m = DATE_TIME.exec((value || '').trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (Number.isNaN(wall)) return null;
  if (!m[4] || params.VALUE === 'DATE') return { wall, kind: 'date' };
  if (m[7]) return { wall, kind: 'utc' };
  if (params.TZID) return { wall, kind: 'zoned', zone: params.TZID };
  return { wall, kind: 'floating' };
};

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const readDuration = (value) => {
  const m = DURATION.exec((value || '').trim());
  if (!m) return null;
  const ms = (((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60000 + +(m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
};

const readRule = (value) => {
  const rule = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  return rule;
};

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// ---------------------------------------------------------------- Parsing
const parse = (text) => {
  const events = [];
  const zones = {};
  let calendarZone = null;
  const stack = [];
  let event = null;
  let zone = null;
  let zonePart = null;

  for (const raw of unfold(text)) {
    if (!raw) continue;
    const line = parseLine(raw);
    if (!line) continue;
    const { name, params, value } = line;
    if (name === 'BEGIN') {
      const what = value.trim().toUpperCase();
      stack.push(what);
      if (what === 'VEVENT' && stack.length === 2 && stack[0] === 'VCALENDAR') {
        event = { exdates: [], rdates: [] };
      } else if (what === 'VTIMEZONE') {
        zone = { id: null, parts: [] };
      } else if (zone && (what === 'STANDARD' || what === 'DAYLIGHT')) {
        zonePart = { start: null, to: null, rule: null };
      }
      continue;
    }
    if (name === 'END') {
      const what = value.trim().toUpperCase();
      // Tolerate a missing END by unwinding to the matching BEGIN
      const at = stack.lastIndexOf(what);
      if (at >= 0) stack.length = at;
      if (what === 'VEVENT' && event) {
        if (events.length < MAX_EVENTS) events.push(event);
        event = null;
      } else if (what === 'VTIMEZONE' && zone) {
        if (zone.id) zones[zone.id] = zone;
        zone = null;
      } else if ((what === 'STANDARD' || what === 'DAYLIGHT') && zone && zonePart) {
        zone.parts.push(zonePart);
        zonePart = null;
      }
      continue;
    }

    const top = stack[stack.length - 1];
    if (top === 'VCALENDAR' && name === 'X-WR-TIMEZONE') calendarZone = value.trim();
    if (zone && top === 'VTIMEZONE' && name === 'TZID') zone.id = value.trim();
    if (zonePart && (top === 'STANDARD' || top === 'DAYLIGHT')) {
      if (name === 'DTSTART') { const d = readDate(value, {}); zonePart.start = d ? d.wall : null; }
      if (name === 'TZOFFSETTO') zonePart.to = value.trim();
      if (name === 'RRULE') zonePart.rule = readRule(value);
    }
    if (!event || top !== 'VEVENT') continue; // VALARM and other nested parts are ignored

    switch (name) {
      case 'UID': event.uid = value.trim(); break;
      case 'DTSTART': event.start = readDate(value, params); break;
      case 'DTEND': event.end = readDate(value, params); break;
      case 'DURATION': event.duration = readDuration(value); break;
      case 'TRANSP': event.transparent = value.trim().toUpperCase() === 'TRANSPARENT'; break;
      case 'STATUS': event.cancelled = value.trim().toUpperCase() === 'CANCELLED'; break;
      case 'X-MICROSOFT-CDO-BUSYSTATUS': event.free = value.trim().toUpperCase() === 'FREE'; break;
      case 'RRULE': event.rule = readRule(value); break;
      case 'RECURRENCE-ID': event.recurrenceId = readDate(value, params); break;
      case 'EXDATE':
        for (const item of value.split(',')) { const d = readDate(item, params); if (d) event.exdates.push(d); }
        break;
      case 'RDATE':
        if ((params.VALUE || '').toUpperCase() !== 'PERIOD') {
          for (const item of value.split(',')) { const d = readDate(item, params); if (d) event.rdates.push(d); }
        }
        break;
      default: break;
    }
  }
  return { events, zones, calendarZone };
};

// ---------------------------------------------------------------- Busy times
// options: { now: ms, days: 60, timeZone: fallback zone for floating times and all-day dates }
const busyTimes = (text, options = {}) => {
  const now = options.now ?? Date.now();
  const windowStart = now - DAY_MS;
  const windowEnd = now + (options.days ?? 60) * DAY_MS;
  const { events, zones, calendarZone } = parse(String(text || ''));

  const fallbackZone = validZone(options.timeZone) ? options.timeZone : 'UTC';
  const floatingZone = validZone(calendarZone) ? calendarZone : fallbackZone;

  const resolveZone = (name) => {
    if (!name) return { iana: floatingZone };
    if (validZone(name)) return { iana: name };
    if (WINDOWS_ZONES[name] && validZone(WINDOWS_ZONES[name])) return { iana: WINDOWS_ZONES[name] };
    // "/mozilla.org/20050126_1/Europe/London" and similar prefixes
    const tail = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(name);
    if (tail && validZone(tail[1])) return { iana: tail[1] };
    if (zones[name] && zones[name].parts.length) return { vtimezone: zones[name] };
    return { iana: floatingZone };
  };

  const toUtc = (wall, kind, zoneName) => {
    if (kind === 'utc') return wall;
    const where = kind === 'zoned' ? resolveZone(zoneName) : { iana: floatingZone };
    if (kind === 'date') return zonedToUtc(wall, fallbackZone);
    if (where.vtimezone) return wall - vtimezoneOffset(where.vtimezone, wall);
    return zonedToUtc(wall, where.iana);
  };

  // Moved or cancelled single occurrences replace that occurrence of the series
  const overridden = new Map();
  for (const ev of events) {
    if (ev.uid && ev.recurrenceId) {
      const key = ev.uid;
      if (!overridden.has(key)) overridden.set(key, new Set());
      overridden.get(key).add(toUtc(ev.recurrenceId.wall, ev.recurrenceId.kind, ev.recurrenceId.zone));
    }
  }

  const out = [];
  const stats = { events: events.length, skipped: 0, unsupportedRules: 0 };
  const add = (start, end, uid) => {
    if (end <= start || end <= windowStart || start >= windowEnd || out.length >= MAX_OUT) return;
    out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(uid ? { uid } : {}) });
  };

  for (const ev of events) {
    if (!ev.start || ev.cancelled || ev.transparent || ev.free) { stats.skipped++; continue; }
    const { kind, zone } = ev.start;
    const allDay = kind === 'date';

    // Length in wall-clock time when start and end are written the same way, so a 9:00-10:00
    // meeting stays 9:00-10:00 across DST changes; otherwise the real length.
    const sameClock = ev.end && ev.end.kind === kind && ev.end.zone === zone;
    let wallLength = null;
    let realLength = null;
    if (sameClock) wallLength = ev.end.wall - ev.start.wall;
    else if (ev.end) realLength = toUtc(ev.end.wall, ev.end.kind, ev.end.zone) - toUtc(ev.start.wall, kind, zone);
    else if (ev.duration !== null && ev.duration !== undefined) wallLength = ev.duration;
    else wallLength = allDay ? DAY_MS : 0;
    if (!((wallLength ?? realLength) > 0)) { stats.skipped++; continue; }

    const instance = (wall) => {
      const start = toUtc(wall, kind, zone);
      const end = wallLength !== null ? toUtc(wall + wallLength, kind, zone) : start + realLength;
      return { start, end };
    };

    // A single event, or a moved occurrence of a series
    if (!ev.rule || ev.recurrenceId) {
      const first = instance(ev.start.wall);
      add(first.start, first.end, ev.uid);
      for (const r of ev.rdates) {
        const at = instance(r.wall);
        add(at.start, at.end, ev.uid);
      }
      continue;
    }

    const excluded = new Set(ev.exdates.map((d) => (d.kind === 'date' && !allDay ? `D${d.wall}` : toUtc(d.wall, d.kind, d.zone))));
    const moved = (ev.uid && overridden.get(ev.uid)) || new Set();
    const skip = (wall, startUtc) =>
      excluded.has(startUtc) || excluded.has(`D${Math.floor(wall / DAY_MS) * DAY_MS}`) || moved.has(startUtc);

    const walls = expand(ev.rule, ev.start.wall, kind, (wall) => toUtc(wall, kind, zone), windowEnd, stats);
    for (const wall of walls) {
      const at = instance(wall);
      if (at.end <= windowStart) continue;
      if (skip(wall, at.start)) continue;
      add(at.start, at.end, ev.uid);
    }
    for (const r of ev.rdates) {
      const at = instance(r.wall);
      if (!skip(r.wall, at.start)) add(at.start, at.end, ev.uid);
    }
  }

  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { busy: out, stats };
};

// Occurrence start times (wall clock, as if UTC) of a rule, from DTSTART up to the window end
const SUPPORTED = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST', 'BYMONTH']);
function expand(rule, startWall, kind, toUtc, windowEnd, stats) {
  const freq = rule.FREQ;
  const unsupported = Object.keys(rule).some((key) => !SUPPORTED.has(key))
    || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)
    || (rule.BYMONTH && freq !== 'YEARLY');
  if (unsupported) {
    stats.unsupportedRules++;
    return [startWall];
  }
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const count = rule.COUNT ? Math.max(0, parseInt(rule.COUNT, 10) || 0) : Infinity;

  // UNTIL is inclusive. A date-only UNTIL means the whole of that day.
  let untilCheck = () => true;
  if (rule.UNTIL) {
    const u = readDate(rule.UNTIL, {});
    if (u) {
      if (u.kind === 'date') untilCheck = (wall) => Math.floor(wall / DAY_MS) * DAY_MS <= u.wall;
      else if (u.kind === 'utc') untilCheck = (wall) => toUtc(wall) <= u.wall;
      else untilCheck = (wall) => wall <= u.wall;
    }
  }

  const start = new Date(startWall);
  const timeOfDay = startWall - Math.floor(startWall / DAY_MS) * DAY_MS;
  const startDay = Math.floor(startWall / DAY_MS) * DAY_MS;
  const byDay = (rule.BYDAY || '').split(',').filter(Boolean).map((item) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
    return m ? { n: m[1] ? Number(m[1]) : 0, day: WEEKDAYS.indexOf(m[2]) } : null;
  }).filter(Boolean);
  const byMonthDay = (rule.BYMONTHDAY || '').split(',').filter(Boolean).map(Number).filter((n) => n && Math.abs(n) <= 31);

  const result = [];
  let made = 0;
  const take = (wall) => {
    if (wall < startWall) return true; // occurrences before DTSTART don't count
    if (!untilCheck(wall) || made >= count) return false;
    made++;
    if (wall - DAY_MS * 2 < windowEnd) result.push(wall);
    return true;
  };

  let steps = 0;
  if (freq === 'DAILY') {
    for (let day = startDay; steps < MAX_STEPS && day < windowEnd + DAY_MS; day += interval * DAY_MS, steps++) {
      const weekday = new Date(day).getUTCDay();
      if (byDay.length && !byDay.some((b) => b.day === weekday)) continue;
      if (byMonthDay.length && !byMonthDay.includes(new Date(day).getUTCDate())) continue;
      if (!take(day + timeOfDay)) break;
    }
  } else if (freq === 'WEEKLY') {
    const wkst = Math.max(0, WEEKDAYS.indexOf(rule.WKST || 'MO'));
    const days = byDay.length ? [...new Set(byDay.map((b) => b.day))] : [start.getUTCDay()];
    // Days of the week in order from the week start
    const order = days.map((d) => (d - wkst + 7) % 7).sort((a, b) => a - b);
    const weekStart = startDay - ((start.getUTCDay() - wkst + 7) % 7) * DAY_MS;
    outer:
    for (let week = weekStart; steps < MAX_STEPS && week < windowEnd + DAY_MS; week += interval * 7 * DAY_MS, steps++) {
      for (const offset of order) {
        if (!take(week + offset * DAY_MS + timeOfDay)) break outer;
      }
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth();
    const months = freq === 'YEARLY' && rule.BYMONTH
      ? rule.BYMONTH.split(',').map((m) => Number(m) - 1).filter((m) => m >= 0 && m < 12).sort((a, b) => a - b)
      : null;
    outer:
    for (; steps < MAX_STEPS && Date.UTC(year, month, 1) < windowEnd + DAY_MS; steps++) {
      const monthList = freq === 'YEARLY' ? (months || [start.getUTCMonth()]) : [month];
      for (const m of monthList) {
        const last = daysInMonth(year, m);
        let dates = [];
        if (byMonthDay.length) {
          dates = byMonthDay.map((n) => (n > 0 ? n : last + n + 1)).filter((d) => d >= 1 && d <= last);
        }
        if (byDay.length) {
          const fromDays = [];
          for (const b of byDay) {
            if (b.n) {
              const d = nthWeekday(year, m, b.n, b.day);
              if (d) fromDays.push(d);
            } else {
              for (let d = 1; d <= last; d++) if (new Date(Date.UTC(year, m, d)).getUTCDay() === b.day) fromDays.push(d);
            }
          }
          dates = byMonthDay.length ? dates.filter((d) => fromDays.includes(d)) : fromDays;
        }
        if (!byMonthDay.length && !byDay.length) {
          const d = start.getUTCDate();
          dates = d <= last ? [d] : []; // the 31st skips shorter months
        }
        for (const d of [...new Set(dates)].sort((a, b) => a - b)) {
          if (!take(Date.UTC(year, m, d) + timeOfDay)) break outer;
        }
      }
      if (freq === 'MONTHLY') {
        month += interval;
        year += Math.floor(month / 12);
        month %= 12;
      } else {
        year += interval;
      }
    }
  }
  return result;
}

module.exports = { busyTimes, parse };
