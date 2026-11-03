import { today } from '@/lib/api';

// Date ranges for reports, ending today unless the period is already over
export const RANGES = [
  { id: '30', name: 'Last 30 days' },
  { id: 'month', name: 'This month' },
  { id: 'last_month', name: 'Last month' },
  { id: 'quarter', name: 'This quarter' },
  { id: 'last_quarter', name: 'Last quarter' },
  { id: 'year', name: 'This year' },
  { id: 'custom', name: 'Choose dates' }
];

const day = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export const rangeDates = (range: string): [string, string] => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = month - (month % 3);
  if (range === 'month') return [day(new Date(year, month, 1)), today()];
  if (range === 'last_month') return [day(new Date(year, month - 1, 1)), day(new Date(year, month, 0))];
  if (range === 'quarter') return [day(new Date(year, quarter, 1)), today()];
  if (range === 'last_quarter') return [day(new Date(year, quarter - 3, 1)), day(new Date(year, quarter, 0))];
  if (range === 'year') return [day(new Date(year, 0, 1)), today()];
  return [day(new Date(year, month, now.getDate() - 29)), today()];
};
