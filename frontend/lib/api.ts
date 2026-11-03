import { getSupabase } from './supabase';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const COMPANY_KEY = 'company';

const savedCompany = () => {
  try {
    return window.localStorage.getItem(COMPANY_KEY) || '';
  } catch {
    return '';
  }
};

// Read once per page load, so a tab keeps its company when another tab switches
let company = typeof window === 'undefined' ? '' : savedCompany();

export const savedCompanyId = () => company;

export const rememberCompany = (id: string) => {
  company = id;
  try {
    window.localStorage.setItem(COMPANY_KEY, id);
  } catch {
    // The choice then lasts only until this page reloads
  }
};

export const openCompany = (id: string) => {
  rememberCompany(id);
  window.location.assign('/saas/accounting');
};

const request = async (method: string, path: string, body?: unknown) => {
  const { data } = await getSupabase().auth.getSession();

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${data.session?.access_token}`,
      ...(company ? { 'X-Company': company } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error || 'Something went wrong. Please try again.', response.status);
  }
  // A CRM save can set off automation, so timelines and alerts check again
  if (method !== 'GET' && path.startsWith('/api/crm/')) window.dispatchEvent(new Event(CRM_SAVED));
  return payload;
};

export const CRM_SAVED = 'crm-saved';

export const api = {
  get: (path: string) => request('GET', path),
  post: (path: string, body: unknown) => request('POST', path, body),
  put: (path: string, body: unknown) => request('PUT', path, body),
  delete: (path: string) => request('DELETE', path)
};

let baseCurrency = 'USD';

export const setBaseCurrency = (currency: string) => {
  baseCurrency = currency;
};

export const money = (value: number | string | null | undefined, currency = baseCurrency) =>
  Number(value || 0).toLocaleString(undefined, { style: 'currency', currency });

// A plain date has no time zone, so it must not be read as UTC midnight
export const formatDate = (value: string | null | undefined) =>
  value ? new Date(value.length === 10 ? `${value}T00:00:00` : value).toLocaleDateString() : '—';

export const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
