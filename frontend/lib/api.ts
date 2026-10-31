import { getSupabase } from './supabase';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const request = async (method: string, path: string, body?: unknown) => {
  const { data } = await getSupabase().auth.getSession();

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${data.session?.access_token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error || 'Something went wrong. Please try again.', response.status);
  }
  return payload;
};

export const api = {
  get: (path: string) => request('GET', path),
  post: (path: string, body: unknown) => request('POST', path, body),
  put: (path: string, body: unknown) => request('PUT', path, body),
  delete: (path: string) => request('DELETE', path)
};

export const money = (value: number | string | null | undefined) =>
  Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

export const formatDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString() : '—';
