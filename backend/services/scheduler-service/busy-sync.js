// Downloads each person's private calendar address and saves their busy times.
// The addresses are read with the service key (only the service can read them back), and every
// download is limited: https only, Google/Outlook/iCloud hosts only, no private networks,
// no redirects to other hosts, 3 MB at most and 10 seconds at most.
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const { createClient } = require('@supabase/supabase-js');
const { busyTimes } = require('./ics');

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;
const HOSTS = /^(calendar\.google\.com|outlook\.office365\.com|outlook\.live\.com|p\d+-caldav\.icloud\.com)$/;

const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const configured = () => Boolean(process.env.SUPABASE_URL && serviceKey());

let serviceClient = null;
const service = () => {
  if (!serviceClient) {
    serviceClient = createClient(process.env.SUPABASE_URL, serviceKey(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return serviceClient.schema('scheduler');
};

// A problem we can explain to the person
class FeedError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Check an address before saving it or downloading it. webcal:// is the same as https://.
const checkUrl = (value) => {
  const raw = String(value || '').trim().replace(/^webcals?:\/\//i, 'https://');
  if (!raw) throw new FeedError('Paste your calendar\'s secret address');
  if (raw.length > 2000) throw new FeedError('That address is too long');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedError('That doesn\'t look like a web address. Copy it again.');
  }
  if (url.protocol !== 'https:') throw new FeedError('The address must start with https://');
  if (url.username || url.password) throw new FeedError('That address can\'t include a user name or password');
  if (url.port && url.port !== '443') throw new FeedError('That address can\'t use a special port');
  if (!HOSTS.test(url.hostname.toLowerCase())) {
    throw new FeedError('Use the secret iCal address from Google Calendar, Outlook or Apple iCloud');
  }
  return url;
};

// Private, local and reserved networks
const privateAddress = (address) => {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return privateAddress(mapped[1]);
  return /^(fc|fd|fe[89ab]|ff)/.test(lower) || lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8');
};

// Checked when the connection is made, so a name can't switch to a private address in between
const safeLookup = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses || [];
    if (!list.length) return callback(new FeedError('We couldn\'t find your calendar\'s server'));
    if (list.some((item) => privateAddress(item.address))) {
      return callback(new FeedError('That address points to a private network, so we can\'t read it'));
    }
    if (options && options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const getOnce = (url, deadline) => new Promise((resolve, reject) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return reject(new FeedError('Your calendar took too long to answer. We\'ll try again in 15 minutes.'));
  const request = https.request(url, {
    method: 'GET',
    lookup: safeLookup,
    headers: {
      'User-Agent': 'get-ly-scheduler/1.0 (busy times)',
      Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br'
    }
  });
  const timer = setTimeout(() => {
    request.destroy(new FeedError('Your calendar took too long to answer. We\'ll try again in 15 minutes.'));
  }, remaining);
  const done = (fn, value) => { clearTimeout(timer); fn(value); };

  request.on('error', (error) => done(reject, error));
  request.on('response', (response) => {
    const status = response.statusCode || 0;
    if (status >= 300 && status < 400) {
      response.resume();
      return done(resolve, { redirect: response.headers.location || '' });
    }
    if (status !== 200) {
      response.resume();
      return done(reject, statusError(status));
    }
    const declared = Number(response.headers['content-length'] || 0);
    if (declared > MAX_BYTES) {
      response.destroy();
      return done(reject, new FeedError('Your calendar is too large to read (over 3 MB)'));
    }
    const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
    let body = response;
    if (encoding === 'gzip' || encoding === 'x-gzip') body = response.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') body = response.pipe(zlib.createInflate());
    else if (encoding === 'br') body = response.pipe(zlib.createBrotliDecompress());

    // The limit counts the unpacked size too
    const chunks = [];
    let size = 0;
    body.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        response.destroy();
        body.destroy();
        done(reject, new FeedError('Your calendar is too large to read (over 3 MB)'));
        return;
      }
      chunks.push(chunk);
    });
    body.on('error', (error) => done(reject, error));
    body.on('end', () => done(resolve, { text: Buffer.concat(chunks).toString('utf8') }));
  });
  request.end();
});

const statusError = (status) => {
  if (status === 404 || status === 410) {
    return new FeedError('Your calendar says this address doesn\'t exist any more. Copy the secret address again and paste it here.');
  }
  if (status === 401 || status === 403) {
    return new FeedError('Your calendar refused this address. It may have been reset. Copy the secret address again and paste it here.');
  }
  if (status === 429 || status >= 500) {
    return new FeedError('Your calendar is busy or down right now. We\'ll try again in 15 minutes.');
  }
  return new FeedError(`Your calendar answered with an error (${status}). We'll try again in 15 minutes.`);
};

const download = async (address) => {
  const deadline = Date.now() + TIMEOUT_MS;
  let url = checkUrl(address);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await getOnce(url, deadline);
    if (result.text !== undefined) return result.text;
    let next;
    try {
      next = new URL(result.redirect, url);
    } catch {
      throw new FeedError('Your calendar sent us to an address we can\'t read');
    }
    if (next.protocol !== 'https:' || !HOSTS.test(next.hostname.toLowerCase()) || (next.port && next.port !== '443')) {
      throw new FeedError('Your calendar sent us to another website, so we stopped for safety');
    }
    url = next;
  }
  throw new FeedError('Your calendar sent us around in circles. Copy the secret address again.');
};

// Plain words for anything that went wrong; details stay in our logs
const plainError = (error) => {
  if (error instanceof FeedError) return error.message;
  const code = error && error.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'We couldn\'t find your calendar\'s server. We\'ll try again in 15 minutes.';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE') {
    return 'We couldn\'t reach your calendar. We\'ll try again in 15 minutes.';
  }
  if (/CERT|TLS|SSL/.test(String(code || '')) || /certificate/i.test(String(error && error.message))) {
    return 'Your calendar\'s server didn\'t pass a security check. We\'ll try again in 15 minutes.';
  }
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR') return 'Your calendar sent something we couldn\'t read. We\'ll try again in 15 minutes.';
  console.error('Busy times download failed:', code || (error && error.message));
  return 'We couldn\'t read your calendar. We\'ll try again in 15 minutes.';
};

// One calendar: download, read, save. Never throws for the calendar's own problems.
const syncFeed = async ({ feed_id: feedId, url, time_zone: timeZone }) => {
  let blocks = null;
  let problem = null;
  try {
    if (!url) throw new FeedError('Your calendar address is missing. Paste it again.');
    const text = await download(url);
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2048))) {
      throw new FeedError('That address didn\'t send a calendar. Make sure you copied the secret address in iCal format.');
    }
    blocks = busyTimes(text, { timeZone, days: 60 }).busy;
  } catch (error) {
    problem = plainError(error);
  }
  const { data, error } = await service().rpc('busy_sync_save', {
    p_feed: feedId, p_blocks: blocks || [], p_error: problem
  });
  if (error) throw error;
  return data;
};

// Every calendar that is due, a few at a time
let running = false;
const syncDue = async ({ budgetMs = 4 * 60 * 1000, parallel = 4 } = {}) => {
  if (running) return { skipped: 'A check is already running' };
  running = true;
  const started = Date.now();
  const totals = { checked: 0, failed: 0 };
  try {
    while (Date.now() - started < budgetMs) {
      const { data, error } = await service().rpc('busy_sync_due', { p_limit: 20 });
      if (error) throw error;
      if (!data || !data.length) break;
      for (let i = 0; i < data.length; i += parallel) {
        const results = await Promise.allSettled(data.slice(i, i + parallel).map(syncFeed));
        for (const result of results) {
          totals.checked++;
          if (result.status === 'rejected' || (result.value && result.value.error)) totals.failed++;
          if (result.status === 'rejected') console.error('Busy times save failed:', result.reason?.message || result.reason);
        }
      }
    }
    return totals;
  } finally {
    running = false;
  }
};

// One calendar, now (after the person saved it or pressed "Check now")
const syncOne = async (feedId) => {
  const { data, error } = await service().rpc('busy_sync_claim', { p_feed: feedId });
  if (error) throw error;
  if (!data || !data.length) return null;
  return syncFeed(data[0]);
};

module.exports = { configured, checkUrl, FeedError, syncDue, syncOne, privateAddress, download, plainError };
