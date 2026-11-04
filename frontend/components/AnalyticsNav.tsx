import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import a from '@/styles/analytics.module.css';

export const SECTIONS = [
  { name: 'Dashboard', path: '/saas/analytics' },
  { name: 'Reports', path: '/saas/analytics/reports' },
  { name: 'Goals', path: '/saas/analytics/goals' },
  { name: 'History', path: '/saas/analytics/history' }
];

export default function AnalyticsNav() {
  const { pathname } = useRouter();
  return (
    <nav className="subnav">
      {SECTIONS.map(({ name, path }) => (
        <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
      ))}
    </nav>
  );
}

// A plain date has no time zone, so dates are built from local parts
export const day = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Whole calendar periods, so each one can be compared with the same stretch before it
export const PERIODS = [
  { id: 'month', name: 'This month', compare: 'last month' },
  { id: 'last_month', name: 'Last month', compare: 'the month before' },
  { id: 'quarter', name: 'This quarter', compare: 'last quarter' },
  { id: 'year', name: 'This year', compare: 'last year' },
  { id: '12', name: 'Last 12 months', compare: 'the 12 months before' },
  { id: 'custom', name: 'Choose dates', compare: 'the same number of days before' }
];

export const periodDates = (period: string): [string, string] => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = month - (month % 3);
  if (period === 'last_month') return [day(new Date(year, month - 1, 1)), day(new Date(year, month, 0))];
  if (period === 'quarter') return [day(new Date(year, quarter, 1)), day(new Date(year, quarter + 3, 0))];
  if (period === 'year') return [day(new Date(year, 0, 1)), day(new Date(year, 11, 31))];
  if (period === '12') return [day(new Date(year, month - 11, 1)), day(new Date(year, month + 1, 0))];
  return [day(new Date(year, month, 1)), day(new Date(year, month + 1, 0))];
};

// The same date a year earlier. 29 February becomes 28 February.
export const yearBefore = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  const last = new Date(y - 1, m, 0).getDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};

export const monthName = (value: string) =>
  new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });


export type Bar = { label: string; values: number[] };

// Up or down against an earlier number. `upIsGood` says which way is good news, so the colour
// is green for good and red for bad; the arrow always shows the direction.
export function Delta({ now, before, upIsGood = true }: { now: number | string; before: number | string; upIsGood?: boolean }) {
  const value = Number(now || 0);
  const earlier = Number(before || 0);
  if (!earlier) {
    return <span className={a.delta}>{value ? 'New' : 'No change'}</span>;
  }
  const percent = Math.round(((value - earlier) / Math.abs(earlier)) * 100);
  if (percent === 0) return <span className={a.delta}>No change</span>;
  const up = percent > 0;
  const tone = up === upIsGood ? a.good : a.bad;
  return (
    <span className={`${a.delta} ${tone}`} aria-label={`${up ? 'Up' : 'Down'} ${Math.abs(percent)}%`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={up ? 'M12 19V5M6 11l6-6 6 6' : 'M12 5v14M6 13l6 6 6-6'} /></svg>
      {Math.abs(percent).toLocaleString()}%
    </span>
  );
}

// A progress ring with the percent in the middle. Green once reached, amber when behind pace.
export function Ring({ percent, size = 72, stroke = 7, behind = false, label }: {
  percent: number; size?: number; stroke?: number; behind?: boolean; label?: string;
}) {
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  const part = Math.max(0, Math.min(1, (Number(percent) || 0) / 100));
  const done = Number(percent) >= 100;
  const centre = size / 2;
  return (
    <svg className={a.ring} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label || `${Math.round(percent)}% of the goal`}>
      <circle className={a.ringTrack} cx={centre} cy={centre} r={r} strokeWidth={stroke} />
      <circle className={`${a.ringFill} ${done ? a.done : behind ? a.behind : ''}`} cx={centre} cy={centre} r={r} strokeWidth={stroke}
        strokeDasharray={length} strokeDashoffset={length * (1 - part)} />
      <text className={a.ringText} x={centre} y={centre + size * 0.07} textAnchor="middle" style={{ transformOrigin: `${centre}px ${centre}px`, fontSize: Math.max(10, size * 0.22) }}>
        {Math.round(Number(percent) || 0)}%
      </text>
    </svg>
  );
}

// Horizontal bars, one row per label, so long names stay readable. Several values make a group.
export function HBarChart({ rows, series, format, title }: {
  rows: Bar[];
  series: string[];
  format: (value: number) => string;
  title: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const values = rows.flatMap((row) => row.values);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const labelWidth = 170;
  const width = 640;
  const plot = width - labelWidth - 90;
  const barHeight = series.length > 1 ? 10 : 16;
  const rowHeight = barHeight * series.length + 12;
  const height = rows.length * rowHeight + 8;
  const x = (value: number) => labelWidth + ((value - min) / span) * plot;
  const shown = active === null ? null : rows[active];

  if (rows.length === 0) return <p className="empty">Nothing to show for these choices</p>;

  return (
    <figure className={a.chart}>
      <figcaption className={a.chartHead}>
        <strong>{title}</strong>
        <span className={a.readout}>
          {shown
            ? <><b>{shown.label}</b>: {shown.values.map((value, n) => `${series.length > 1 ? `${series[n]} ` : ''}${format(value)}`).join(', ')}</>
            : 'Point at a bar to see its number'}
        </span>
      </figcaption>
      {series.length > 1 && (
        <div className={a.legend}>
          {series.map((name, n) => <span key={name}><i className={n % 2 ? a.tone2 : a.tone1} />{name}</span>)}
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} onMouseLeave={() => setActive(null)}>
        {[0.25, 0.5, 0.75, 1].map((share) => (
          <line key={share} x1={x(min + span * share)} x2={x(min + span * share)} y1={0} y2={height} className={a.grid} />
        ))}
        <line x1={x(0)} x2={x(0)} y1={0} y2={height} className={a.zero} />
        {rows.map((row, index) => {
          const top = index * rowHeight + 5;
          return (
            <g key={`${row.label}-${index}`} className={active === index ? a.on : ''}>
              <rect className={a.column} x={0} y={top - 3} width={width} height={rowHeight - 2} rx={6} />
              <text x={labelWidth - 10} y={top + (rowHeight - 12) / 2 + 4} textAnchor="end" className={a.tick}>
                {row.label.length > 24 ? `${row.label.slice(0, 23)}…` : row.label}
              </text>
              {row.values.map((value, n) => {
                const start = Math.min(x(value), x(0));
                return (
                  <rect key={n} className={`${a.bar} ${n % 2 ? a.tone2 : a.tone1} ${value < 0 ? a.negative : ''}`} x={start} y={top + n * barHeight}
                    width={Math.max(Math.abs(x(value) - x(0)), value ? 2 : 0)} height={barHeight - 2} rx={Math.min(4, (barHeight - 2) / 2)} />
                );
              })}
              {series.length === 1 && (
                <text x={Math.max(x(row.values[0]), x(0)) + 6} y={top + barHeight - 4} className={a.tick}>{format(row.values[0])}</text>
              )}
              <rect className={a.hit} x={0} y={top - 3} width={width} height={rowHeight}
                onMouseEnter={() => setActive(index)} onClick={() => setActive(index)}>
                <title>{`${row.label}: ${row.values.map((value, n) => `${series[n]} ${format(value)}`).join(', ')}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

// A simple line for a daily number, with a soft fill under it. Gaps (days with no snapshot) are skipped.
export function Sparkline({ points, label }: { points: { day: string; value: number }[]; label: string }) {
  const width = 300;
  const height = 60;
  if (points.length < 2) return <p className="muted small" style={{ margin: '8px 0 0' }}>The trend shows once there are two days of history.</p>;
  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const first = new Date(`${points[0].day}T00:00:00`).getTime();
  const last = new Date(`${points[points.length - 1].day}T00:00:00`).getTime();
  const x = (value: string) => ((new Date(`${value}T00:00:00`).getTime() - first) / (last - first || 1)) * (width - 4) + 2;
  const y = (value: number) => height - 4 - ((value - min) / span) * (height - 8);
  const path = points.map((point, n) => `${n ? 'L' : 'M'}${x(point.day).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  const end = points[points.length - 1];
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ overflow: 'visible' }}>
      <path d={`${path} L${x(end.day).toFixed(1)},${height} L${x(points[0].day).toFixed(1)},${height} Z`} style={{ fill: 'var(--accent-soft)', stroke: 'none' }} />
      <path d={path} />
      <circle cx={x(end.day)} cy={y(end.value)} r={3} style={{ fill: 'var(--series-1)', stroke: 'var(--surface)', strokeWidth: 1.5 }} />
    </svg>
  );
}
