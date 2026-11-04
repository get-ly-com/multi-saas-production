import { useEffect, useRef, useState } from 'react';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { api, formatDate, money } from '@/lib/api';
import { cachedGet } from '@/lib/cache';
import s from '@/styles/brain.module.css';

// "Your business at a glance": the cash forecast and the What if simulator on the Brain page.

type Forecast = {
  currency: string; today: string; days: number; opening_balance: number;
  points: { days: number; date: string; balance: number; money_in: number; money_out: number }[];
  lowest_point: { date: string; balance: number };
  first_below_zero: string | null; warning: string | null;
  assumptions: string[]; data_notes: string[];
};

const dayNumber = (date: string) => Math.round(new Date(`${date}T00:00:00Z`).getTime() / 86400000);

function ForecastChart({ data }: { data: Forecast }) {
  const width = 300;
  const height = 120;
  const pad = { top: 12, right: 10, bottom: 18, left: 10 };
  const start = dayNumber(data.today);
  const series = [
    { day: 0, balance: data.opening_balance, date: data.today },
    ...data.points.map((point) => ({ day: point.days, balance: point.balance, date: point.date }))
  ];
  const low = data.lowest_point;
  const lowDay = low ? dayNumber(low.date) - start : 0;
  if (low && lowDay > 0 && !series.some((point) => point.day === lowDay)) series.push({ day: lowDay, balance: low.balance, date: low.date });
  series.sort((a, b) => a.day - b.day);

  const values = series.map((point) => point.balance);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const x = (day: number) => pad.left + (day / data.days) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + ((max - value) / span) * (height - pad.top - pad.bottom);
  const line = series.map((point, n) => `${n ? 'L' : 'M'}${x(point.day).toFixed(1)},${y(point.balance).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series[series.length - 1].day).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const dips = low && low.balance < 0;

  return (
    <svg className={s.chart} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`Cash today ${money(data.opening_balance, data.currency)}, lowest ${money(low?.balance, data.currency)} on ${formatDate(low?.date)}`}>
      <line className={s.zero} x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
      <text className={s.axis} x={width - pad.right} y={y(0) - 4} textAnchor="end">0</text>
      <path className={dips ? s.areaWarn : s.area} d={area} />
      <path className={dips ? s.lineWarn : s.line} d={line} />
      {low && (
        <g>
          <circle className={dips ? s.lowDotWarn : s.lowDot} cx={x(Math.max(lowDay, 0))} cy={y(low.balance)} r="4" />
          <text className={s.axis} x={Math.min(Math.max(x(Math.max(lowDay, 0)), 40), width - 40)} y={Math.min(y(low.balance) + 16, height - 4)} textAnchor="middle">Lowest</text>
        </g>
      )}
      {data.points.map((point) => (
        <text key={point.days} className={s.axis} x={x(point.days)} y={height - 4} textAnchor={point.days === data.days ? 'end' : 'middle'}>{point.days}d</text>
      ))}
      <text className={s.axis} x={pad.left} y={height - 4}>Today</text>
    </svg>
  );
}

export function ForecastCard() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Forecast | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [showWhy, setShowWhy] = useState(false);

  useEffect(() => {
    let current = true;
    setState('loading');
    cachedGet(`/api/brain/forecast?days=${days}`)
      .then((result) => { if (current) { setData(result); setState('ok'); } })
      .catch(() => current && setState('error'));
    return () => { current = false; };
  }, [days]);

  const end = data?.points[data.points.length - 1];
  return (
    <section className={`card ${s.glanceCard}`} aria-labelledby="forecast-title">
      <div className={s.glanceHead}>
        <h3 id="forecast-title">Cash forecast</h3>
        <div className={s.segmented} role="group" aria-label="How far ahead">
          {[30, 60, 90].map((n) => (
            <button key={n} type="button" className={`always ${days === n ? s.segOn : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>
          ))}
        </div>
      </div>
      {state === 'loading' && !data && <><Skeleton height={120} radius={8} /><Skeleton width="60%" height={12} style={{ marginTop: 10 }} /></>}
      {state === 'error' && <p className="muted small">We couldn&apos;t make a forecast just now.</p>}
      {data && state !== 'error' && (
        <div className={state === 'loading' ? s.fading : ''}>
          <ForecastChart data={data} />
          <dl className={s.figures}>
            <div><dt>Today</dt><dd className="num">{money(data.opening_balance, data.currency)}</dd></div>
            {end && <div><dt>In {end.days} days</dt><dd className="num">{money(end.balance, data.currency)}</dd></div>}
            <div><dt>Lowest point</dt><dd className={`num ${data.lowest_point.balance < 0 ? s.bad : ''}`}>{money(data.lowest_point.balance, data.currency)}<small>{formatDate(data.lowest_point.date)}</small></dd></div>
          </dl>
          {data.warning && <p className={s.warnNote}><Icon name="warn" size={15} />{data.warning}</p>}
          {data.data_notes.map((text) => <p key={text} className="muted small">{text}</p>)}
          <button type="button" className="link small always" onClick={() => setShowWhy((v) => !v)} aria-expanded={showWhy}>
            {showWhy ? 'Hide the assumptions' : 'How is this worked out?'}
          </button>
          {showWhy && <ul className={s.assumptions}>{data.assumptions.map((text) => <li key={text}>{text}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}

type Scenario = {
  currency: string; months: number;
  baseline: { monthly_revenue: number; monthly_costs: number; monthly_profit: number };
  scenario: { monthly_revenue: number; monthly_costs: number; monthly_profit: number };
  change: { monthly_profit: number; monthly_revenue: number; monthly_costs: number };
  cash: { now: number; one_off_collected: number; projected_without_change: number; projected_with_change: number; after_months: number };
  assumptions: string[]; data_notes: string[];
};

type Inputs = { price_change_pct: number; new_hire_monthly_cost: number; expense_change_pct: number; collect_overdue_pct: number };
const START: Inputs = { price_change_pct: 0, new_hire_monthly_cost: 0, expense_change_pct: 0, collect_overdue_pct: 0 };

const signed = (value: number, currency: string) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value), currency)}`;

export function WhatIf() {
  const [inputs, setInputs] = useState<Inputs>(START);
  const [result, setResult] = useState<Scenario | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const latest = useRef(0);

  // A read, not a change: the newest answer wins, so the sliders feel live
  useEffect(() => {
    const ask = ++latest.current;
    setWorking(true);
    const timer = setTimeout(() => {
      api.post('/api/brain/simulate', { ...inputs, months: 3 })
        .then((data) => { if (ask === latest.current) { setResult(data); setError(''); } })
        .catch((err) => { if (ask === latest.current) setError(err?.message || 'We couldn’t work that out just now.'); })
        .finally(() => { if (ask === latest.current) setWorking(false); });
    }, result ? 350 : 0);
    return () => clearTimeout(timer);
  }, [inputs]);

  const set = (key: keyof Inputs) => (event: { target: { value: string } }) => {
    const n = Number(event.target.value);
    setInputs((now) => ({ ...now, [key]: Number.isFinite(n) ? n : 0 }));
  };
  const changed = Object.entries(inputs).some(([key, value]) => value !== START[key as keyof Inputs]);
  const currency = result?.currency;

  return (
    <section className={`card ${s.glanceCard}`} aria-labelledby="whatif-title">
      <div className={s.glanceHead}>
        <h3 id="whatif-title">What if…</h3>
        {changed && <button type="button" className="ghost small always" onClick={() => setInputs(START)}>Reset</button>}
      </div>
      <div className={s.sliders}>
        <label className={s.slider}>
          <span>Change prices <output className="num">{inputs.price_change_pct > 0 ? '+' : ''}{inputs.price_change_pct}%</output></span>
          <input type="range" min={-30} max={50} step={1} value={inputs.price_change_pct} onChange={set('price_change_pct')} />
        </label>
        <label className={s.slider}>
          <span>Change costs <output className="num">{inputs.expense_change_pct > 0 ? '+' : ''}{inputs.expense_change_pct}%</output></span>
          <input type="range" min={-50} max={50} step={1} value={inputs.expense_change_pct} onChange={set('expense_change_pct')} />
        </label>
        <label className={s.slider}>
          <span>Collect overdue invoices <output className="num">{inputs.collect_overdue_pct}%</output></span>
          <input type="range" min={0} max={100} step={5} value={inputs.collect_overdue_pct} onChange={set('collect_overdue_pct')} />
        </label>
        <label className={s.slider}>
          <span>New hire, monthly cost</span>
          <input type="number" min={0} step={100} inputMode="numeric" value={inputs.new_hire_monthly_cost || ''} placeholder="0" onChange={set('new_hire_monthly_cost')} />
        </label>
      </div>

      {!result && !error && <><Skeleton height={56} radius={8} /><Skeleton width="70%" height={12} style={{ marginTop: 8 }} /></>}
      {error && <p className="muted small">{error}</p>}
      {result && (
        <div className={`${s.scenario} ${working ? s.fading : ''}`} aria-live="polite">
          <div>
            <span className={s.label}>Profit a month</span>
            <strong className="num">{money(result.scenario.monthly_profit, currency)}</strong>
            {changed && <span className={`num ${result.change.monthly_profit >= 0 ? s.good : s.bad}`}>{signed(result.change.monthly_profit, result.currency)}</span>}
          </div>
          <div>
            <span className={s.label}>Cash in {result.cash.after_months} months</span>
            <strong className={`num ${result.cash.projected_with_change < 0 ? s.bad : ''}`}>{money(result.cash.projected_with_change, currency)}</strong>
            {changed && <span className="num muted">was {money(result.cash.projected_without_change, currency)}</span>}
          </div>
        </div>
      )}
      {result?.data_notes.map((text) => <p key={text} className="muted small">{text}</p>)}
      {result && (
        <>
          <button type="button" className="link small always" onClick={() => setShowWhy((v) => !v)} aria-expanded={showWhy}>
            {showWhy ? 'Hide the assumptions' : 'What this assumes'}
          </button>
          {showWhy && <ul className={s.assumptions}>{result.assumptions.map((text) => <li key={text}>{text}</li>)}</ul>}
        </>
      )}
    </section>
  );
}
