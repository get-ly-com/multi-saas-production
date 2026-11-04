'use strict';

// The get-ly public API (see backend/services/api-gateway/server.js, "Public API").
// Every call sends the company's API key as "Authorization: Bearer gk_...". Lists come back
// oldest first by created_at: { data, limit, offset, has_more, next_offset }, at most 100 a page.

const PAGE = 100;
const MAX_OFFSET = 1000000; // the API caps offsets here

// Set once per version with: zapier env:set 1.0.0 GETLY_API_URL=https://your-gateway-address
const baseUrl = () => {
  const url = (process.env.GETLY_API_URL || '').replace(/\/+$/, '');
  if (!url) {
    throw new Error('GETLY_API_URL is not set for this integration version. Run: zapier env:set <version> GETLY_API_URL=https://...');
  }
  return `${url}/api/v1`;
};

const addApiKey = (request, z, bundle) => {
  const key = ((bundle.authData && bundle.authData.api_key) || '').trim();
  if (key) request.headers.Authorization = `Bearer ${key}`;
  request.headers.Accept = 'application/json';
  return request;
};

// The API's own error messages are written for people, so they are passed on as they are
const handleErrors = (response, z) => {
  if (response.status < 400) return response;
  let message = `get-ly answered with status ${response.status}`;
  try {
    const body = response.data && typeof response.data === 'object' ? response.data : JSON.parse(response.content);
    if (body && body.error) message = body.error;
  } catch (error) {
    // Not JSON; keep the plain message
  }
  if (response.status === 401) throw new z.errors.RefreshAuthError(message);
  if (response.status === 429) throw new z.errors.ThrottledError(message, 60);
  throw new z.errors.Error(message, `http_${response.status}`, response.status);
};

const getPage = async (z, resource, offset, limit) => {
  const response = await z.request({
    url: `${baseUrl()}/${resource}`,
    params: { limit, offset }
  });
  return response.data;
};

// How many rows the list has. Zapier wants the newest records first, but the API lists oldest
// first, so the end of the list is found with one-row probes (doubling, then halving): about
// 2 x log2(rows / 100) small requests, well inside the 60 a minute allowed per key.
const countRows = async (z, resource, first) => {
  if (!first.has_more) return first.data.length;
  const exists = async (offset) => (await getPage(z, resource, offset, 1)).data.length > 0;
  let lo = PAGE; // has_more says row 100 (counting from 0) is there
  let hi = PAGE * 2;
  while (hi <= MAX_OFFSET && (await exists(hi))) {
    lo = hi;
    hi *= 2;
  }
  hi = Math.min(hi, MAX_OFFSET + 1);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo + 1;
};

// The last `count` records, newest first
const newest = async (z, resource, count = PAGE) => {
  const first = await getPage(z, resource, 0, PAGE);
  if (!first.has_more) return first.data.slice().reverse().slice(0, count);

  const total = await countRows(z, resource, first);
  const rows = [];
  for (let end = total; end > 0 && rows.length < count; end -= PAGE) {
    const start = Math.max(0, end - PAGE);
    const page = await getPage(z, resource, start, end - start);
    rows.push(...page.data.slice().reverse());
  }
  return rows.slice(0, count);
};

// Adds a record. The API answers { created, data }; created is false when the email was already
// there (the existing contact, or an open lead that got a note instead of a duplicate).
const create = async (z, resource, body) => {
  const response = await z.request({
    method: 'POST',
    url: `${baseUrl()}/${resource}`,
    body
  });
  const { created, data } = response.data || {};
  return { ...(data || {}), was_new: Boolean(created) };
};

// Drops blank optional fields, so the API never sees "" for a field left empty in the Zap
const compact = (object) => Object.fromEntries(
  Object.entries(object).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
);

module.exports = { baseUrl, addApiKey, handleErrors, getPage, countRows, newest, create, compact, PAGE };
