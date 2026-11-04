import { getBaseCurrency } from '@/lib/api';

// Number helpers for tiles and summaries. Tables keep using money() from lib/api.

export const count = (value: number | string | null | undefined) => Number(value || 0).toLocaleString();

// $12.4K, for tiles where the exact cents don't matter
export const compactMoney = (value: number | string | null | undefined, currency = getBaseCurrency()) => {
  const number = Number(value || 0);
  try {
    return number.toLocaleString(undefined, {
      style: 'currency', currency, notation: Math.abs(number) >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(number) >= 10_000 ? 1 : 0
    });
  } catch {
    return number.toLocaleString();
  }
};

// "12% more than last month", or null when there is nothing fair to compare with
export const change = (now: number | string, before: number | string) => {
  const a = Number(now || 0);
  const b = Number(before || 0);
  if (!b) return null;
  const percent = Math.round(((a - b) / Math.abs(b)) * 100);
  return { percent, up: percent > 0, flat: percent === 0 };
};

export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${Number(n) === 1 ? one : many}`;

// Local calendar days as YYYY-MM-DD
export const localDay = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export const monthRange = (offset = 0): [string, string] => {
  const now = new Date();
  return [localDay(new Date(now.getFullYear(), now.getMonth() + offset, 1)), localDay(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0))];
};
