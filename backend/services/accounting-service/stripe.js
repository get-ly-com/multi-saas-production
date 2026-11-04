// Small helpers for Stripe Checkout, called with fetch. The keys come only from this service's
// environment (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET), never from the database or the app.
const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com/v1';

// Stripe takes amounts in the currency's smallest unit. Most have cents; these have none.
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
// These have three decimals
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
// Stripe takes these with two decimals, but only charges whole amounts
const WHOLE_ONLY = new Set(['HUF', 'ISK', 'TWD', 'UGX']);

const decimalsOf = (currency) => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);

class PayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// An amount from the books (two decimals at most) in Stripe's smallest unit
const toMinor = (amount, currency) => {
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new PayError('There is nothing to pay on this invoice');
  if ((ZERO_DECIMAL.has(currency) || WHOLE_ONLY.has(currency)) && cents % 100 !== 0) {
    throw new PayError(`Card payments in ${currency} need a whole amount. Please contact the company to pay.`);
  }
  if (ZERO_DECIMAL.has(currency)) return cents / 100;
  if (THREE_DECIMAL.has(currency)) return cents * 10;
  return cents;
};

// Stripe's smallest unit back to an amount for the books
const fromMinor = (minor, currency) => {
  const value = Number(minor);
  if (!Number.isSafeInteger(value)) return NaN;
  return Math.round((value / 10 ** decimalsOf(currency)) * 100) / 100;
};

// Checks the Stripe-Signature header: "t=<unix time>,v1=<hex HMAC-SHA256 of 't.<raw body>'>".
// Stripe may send more than one v1 while a secret is being rolled; any match is enough.
const verifySignature = (rawBody, header, secret, { tolerance = 300, now = Date.now() / 1000 } = {}) => {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || !secret) return false;
  let timestamp = '';
  const signatures = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (!/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now - Number(timestamp)) > tolerance) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((signature) => /^[0-9a-f]{64}$/i.test(signature)
    && crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expected));
};

// Nested objects become Stripe's form fields, e.g. line_items[0][price_data][currency]
const formFields = (value, prefix, out = new URLSearchParams()) => {
  if (value === undefined || value === null) return out;
  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) formFields(inner, prefix ? `${prefix}[${key}]` : key, out);
  } else {
    out.append(prefix, String(value));
  }
  return out;
};

const createCheckoutSession = async (params) => {
  const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formFields(params),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.id || !body?.url) {
    const code = body?.error?.code;
    // Stripe's own wording is not shown to customers; it goes to the logs
    console.error('[stripe]', response.status, code || '', body?.error?.message || '');
    if (code === 'amount_too_small') throw new PayError('This amount is too small to pay by card.');
    if (code === 'amount_too_large') throw new PayError('This amount is too large to pay by card. Please contact the company to pay.');
    throw new PayError('The card payment could not be started. Please try again later.', 502);
  }
  return body;
};

module.exports = { PayError, toMinor, fromMinor, verifySignature, createCheckoutSession };
