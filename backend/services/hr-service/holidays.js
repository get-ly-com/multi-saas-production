// National public holidays for a few countries, worked out from fixed rules so no outside service is
// needed. Regional holidays (German states, Spanish regions, US states) aren't included: add those by hand.

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

// Easter Sunday (Gregorian calendar)
const easter = (y) => {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return day(y, month, ((h + l - 7 * m + 114) % 31) + 1);
};

// nth weekday of a month (weekday 0 = Sunday); n = -1 for the last one
const nthWeekday = (y, m, weekday, n) => {
  if (n > 0) {
    const first = day(y, m, 1);
    return addDays(first, ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7);
  }
  const last = day(y, m + 1, 0);
  return addDays(last, -((last.getUTCDay() - weekday + 7) % 7));
};

// UK and Irish style: a holiday on a weekend moves to the next weekday that isn't already a holiday
const substitute = (list, names) => {
  // Holidays already on a weekday keep their day; only weekend ones move
  const moves = (h) => names.includes(h.name) && isWeekend(h.date);
  const taken = new Set(list.filter((h) => !moves(h)).map((h) => iso(h.date)));
  return list.map((h) => {
    if (!moves(h)) return h;
    let d = h.date;
    while (isWeekend(d) || taken.has(iso(d))) d = addDays(d, 1);
    taken.add(iso(d));
    return iso(d) === iso(h.date) ? h : { date: d, name: `${h.name} (substitute day)` };
  });
};

// US style: Saturday is observed on Friday, Sunday on Monday
const observed = (h) => {
  const wd = h.date.getUTCDay();
  if (wd === 6) return { date: addDays(h.date, -1), name: `${h.name} (observed)` };
  if (wd === 0) return { date: addDays(h.date, 1), name: `${h.name} (observed)` };
  return h;
};

const COUNTRIES = {
  GB: {
    name: 'United Kingdom (England and Wales)',
    days: (y) => {
      const e = easter(y);
      return substitute([
        { date: day(y, 1, 1), name: "New Year's Day" },
        { date: addDays(e, -2), name: 'Good Friday' },
        { date: addDays(e, 1), name: 'Easter Monday' },
        { date: nthWeekday(y, 5, 1, 1), name: 'Early May bank holiday' },
        { date: nthWeekday(y, 5, 1, -1), name: 'Spring bank holiday' },
        { date: nthWeekday(y, 8, 1, -1), name: 'Summer bank holiday' },
        { date: day(y, 12, 25), name: 'Christmas Day' },
        { date: day(y, 12, 26), name: 'Boxing Day' }
      ], ["New Year's Day", 'Christmas Day', 'Boxing Day']);
    }
  },
  IE: {
    name: 'Ireland',
    days: (y) => {
      const e = easter(y);
      const feb1 = day(y, 2, 1);
      return substitute([
        { date: day(y, 1, 1), name: "New Year's Day" },
        { date: feb1.getUTCDay() === 5 ? feb1 : nthWeekday(y, 2, 1, 1), name: "St Brigid's Day" },
        { date: day(y, 3, 17), name: "St Patrick's Day" },
        { date: addDays(e, 1), name: 'Easter Monday' },
        { date: nthWeekday(y, 5, 1, 1), name: 'May bank holiday' },
        { date: nthWeekday(y, 6, 1, 1), name: 'June bank holiday' },
        { date: nthWeekday(y, 8, 1, 1), name: 'August bank holiday' },
        { date: nthWeekday(y, 10, 1, -1), name: 'October bank holiday' },
        { date: day(y, 12, 25), name: 'Christmas Day' },
        { date: day(y, 12, 26), name: "St Stephen's Day" }
      ], ["New Year's Day", "St Patrick's Day", 'Christmas Day', "St Stephen's Day"]);
    }
  },
  DE: {
    name: 'Germany (nationwide)',
    days: (y) => {
      const e = easter(y);
      return [
        { date: day(y, 1, 1), name: 'Neujahr' },
        { date: addDays(e, -2), name: 'Karfreitag' },
        { date: addDays(e, 1), name: 'Ostermontag' },
        { date: day(y, 5, 1), name: 'Tag der Arbeit' },
        { date: addDays(e, 39), name: 'Christi Himmelfahrt' },
        { date: addDays(e, 50), name: 'Pfingstmontag' },
        { date: day(y, 10, 3), name: 'Tag der Deutschen Einheit' },
        { date: day(y, 12, 25), name: '1. Weihnachtstag' },
        { date: day(y, 12, 26), name: '2. Weihnachtstag' }
      ];
    }
  },
  FR: {
    name: 'France',
    days: (y) => {
      const e = easter(y);
      return [
        { date: day(y, 1, 1), name: "Jour de l'an" },
        { date: addDays(e, 1), name: 'Lundi de Pâques' },
        { date: day(y, 5, 1), name: 'Fête du Travail' },
        { date: day(y, 5, 8), name: 'Victoire 1945' },
        { date: addDays(e, 39), name: 'Ascension' },
        { date: addDays(e, 50), name: 'Lundi de Pentecôte' },
        { date: day(y, 7, 14), name: 'Fête nationale' },
        { date: day(y, 8, 15), name: 'Assomption' },
        { date: day(y, 11, 1), name: 'Toussaint' },
        { date: day(y, 11, 11), name: 'Armistice 1918' },
        { date: day(y, 12, 25), name: 'Noël' }
      ];
    }
  },
  NL: {
    name: 'Netherlands',
    days: (y) => {
      const e = easter(y);
      const kings = day(y, 4, 27);
      return [
        { date: day(y, 1, 1), name: 'Nieuwjaarsdag' },
        { date: addDays(e, 1), name: 'Tweede paasdag' },
        { date: kings.getUTCDay() === 0 ? day(y, 4, 26) : kings, name: 'Koningsdag' },
        ...(y % 5 === 0 ? [{ date: day(y, 5, 5), name: 'Bevrijdingsdag' }] : []),
        { date: addDays(e, 39), name: 'Hemelvaartsdag' },
        { date: addDays(e, 50), name: 'Tweede pinksterdag' },
        { date: day(y, 12, 25), name: 'Eerste kerstdag' },
        { date: day(y, 12, 26), name: 'Tweede kerstdag' }
      ];
    }
  },
  ES: {
    name: 'Spain (national)',
    days: (y) => {
      const e = easter(y);
      return [
        { date: day(y, 1, 1), name: 'Año Nuevo' },
        { date: day(y, 1, 6), name: 'Epifanía del Señor' },
        { date: addDays(e, -2), name: 'Viernes Santo' },
        { date: day(y, 5, 1), name: 'Fiesta del Trabajo' },
        { date: day(y, 8, 15), name: 'Asunción de la Virgen' },
        { date: day(y, 10, 12), name: 'Fiesta Nacional de España' },
        { date: day(y, 11, 1), name: 'Todos los Santos' },
        { date: day(y, 12, 6), name: 'Día de la Constitución' },
        { date: day(y, 12, 8), name: 'Inmaculada Concepción' },
        { date: day(y, 12, 25), name: 'Navidad' }
      ];
    }
  },
  US: {
    name: 'United States (federal)',
    days: (y) => [
      // Next year's New Year's Day can be observed on 31 December of this year
      observed({ date: day(y, 1, 1), name: "New Year's Day" }),
      { date: nthWeekday(y, 1, 1, 3), name: 'Martin Luther King Jr. Day' },
      { date: nthWeekday(y, 2, 1, 3), name: "Washington's Birthday" },
      { date: nthWeekday(y, 5, 1, -1), name: 'Memorial Day' },
      observed({ date: day(y, 6, 19), name: 'Juneteenth' }),
      observed({ date: day(y, 7, 4), name: 'Independence Day' }),
      { date: nthWeekday(y, 9, 1, 1), name: 'Labor Day' },
      { date: nthWeekday(y, 10, 1, 2), name: 'Columbus Day' },
      observed({ date: day(y, 11, 11), name: 'Veterans Day' }),
      { date: nthWeekday(y, 11, 4, 4), name: 'Thanksgiving Day' },
      observed({ date: day(y, 12, 25), name: 'Christmas Day' }),
      observed({ date: day(y + 1, 1, 1), name: "New Year's Day" })
    ]
  }
};

const countries = () => Object.entries(COUNTRIES).map(([code, { name }]) => ({ code, name }));

// Holidays that fall in the year, sorted by date
const holidaysFor = (code, year) => {
  const country = COUNTRIES[code];
  if (!country || !Number.isInteger(year) || year < 2000 || year > 2100) return null;
  const seen = new Set();
  return country.days(year)
    .map((h) => ({ date: iso(h.date), name: h.name }))
    .filter((h) => h.date.startsWith(`${year}-`) && !seen.has(h.date) && seen.add(h.date))
    .sort((a, b) => a.date.localeCompare(b.date));
};

module.exports = { countries, holidaysFor };
