require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3008;

// A planner only: nothing here posts to any social platform. People post from the platform
// themself and record the live link. Queries run as the signed-in user, so database policies
// decide who can see and change what.
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS = ['x', 'linkedin', 'facebook', 'instagram'];
const STATUSES = ['draft', 'needs_approval', 'approved', 'scheduled', 'posted'];
const LIMITS = { x: 280, linkedin: 3000, facebook: 63206, instagram: 2200 };

const social = (req) => req.db.schema('social');
const POST_FIELDS = '*, targets:post_targets(id, account_id, platform, body, posted_at, post_url, posted_by, '
  + 'likes, comments, shares, clicks, views, stats_at, account:accounts(id, platform, handle, profile_url, is_active))';

// Only our own messages and the ones our database functions raise (P0001) reach people
const sendError = (res, error) => {
  const code = error?.code || '';
  if (error?.status) return res.status(error.status).json({ error: error.message });
  if (!code && error?.constructor === Error) return res.status(400).json({ error: error.message });
  if (code === 'P0001') return res.status(400).json({ error: error.message });
  if (/^PT[45]\d\d$/.test(code)) return res.status(Number(code.slice(2))).json({ error: error.message });

  console.error('Social error:', error);
  if (code === '42501') return res.status(403).json({ error: 'You don’t have access to that' });
  if (code === '22P02') return res.status(404).json({ error: 'Not found' });
  if (code === '23503') return res.status(409).json({ error: 'That is still in use' });
  if (code === '23505') return res.status(409).json({ error: 'That is already saved' });
  if (code === '23514') return res.status(400).json({ error: 'That value isn’t allowed' });
  res.status(400).json({ error: 'That didn’t work. Please check and try again.' });
};

const id = (value, label) => {
  if (!UUID.test(value || '')) throw new Error(`${label} not found`);
  return value;
};

const text = (value, max) => {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
};

// An ISO date-time from the browser, or null for "no date yet"
const when = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error('Choose a valid date and time');
  return parsed.toISOString();
};

const call = async (req, name, params) => {
  const { data, error } = await social(req).rpc(name, { p_tenant: req.tenantId, ...params });
  if (error) throw error;
  return data ?? { success: true };
};

const callSocial = (name, params, status = 200) => async (req, res) => {
  try {
    res.status(status).json(await call(req, name, params(req)));
  } catch (error) {
    sendError(res, error);
  }
};

const handle = (work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (error) {
    sendError(res, error);
  }
};

const rows = async (query) => {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

// Characters as people count them (an emoji is one), which is how the database counts too
const length = (value) => Array.from(value).length;

const postFields = (body) => {
  const targets = Array.isArray(body.targets) ? body.targets : [];
  if (targets.length > 10) throw new Error('Choose up to 10 accounts');
  const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[\s,]+/);
  return {
    title: text(body.title, 200).trim(),
    campaign: text(body.campaign, 100).trim(),
    tags: tags.map((tag) => text(tag, 51).trim()).filter(Boolean).slice(0, 21),
    link_url: text(body.link_url, 500).trim(),
    scheduled_at: when(body.scheduled_at),
    assigned_to: body.assigned_to ? id(body.assigned_to, 'Person') : null,
    image_path: text(body.image_path, 500) || null,
    notes: text(body.notes, 2000),
    targets: targets.map((target) => {
      const value = text(target?.body, LIMITS.facebook + 1);
      if (target?.platform && LIMITS[target.platform] && length(value) > LIMITS[target.platform]) {
        throw new Error(`That text is ${length(value)} characters. The limit is ${LIMITS[target.platform]}.`);
      }
      return { account_id: id(target?.account_id, 'Account'), body: value };
    })
  };
};

const accountFields = (body) => ({
  platform: PLATFORMS.includes(body.platform) ? body.platform : null,
  handle: text(body.handle, 100).trim(),
  profile_url: text(body.profile_url, 500).trim(),
  ...(body.is_active === undefined ? {} : { is_active: Boolean(body.is_active) })
});

app.use(express.json({ limit: '512kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'social-media-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

// The company id is the image folder name, so the browser needs it to upload
// "me" (the signed-in person, from the token the gateway already checked) shows whose comments are whose.
app.get('/overview', handle(async (req) => {
  let me = null;
  try {
    const payload = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url').toString('utf8'));
    me = UUID.test(payload.sub || '') ? payload.sub : null;
  } catch {
    // Without it, people just don't see "Remove" on their own comments
  }
  return { ...(await call(req, 'overview', {})), tenant_id: req.tenantId, me };
}));

// Alerts people about posts due today. The planner calls it when it opens.
app.post('/check-due', callSocial('check_due', () => ({})));

// Per campaign: posts, and the leads, contacts, chats and won deals that came from it
app.get('/campaign-results', callSocial('campaign_results', () => ({})));

app.put('/settings', callSocial('save_settings', (req) => ({
  p_require_approval: Boolean(req.body.require_approval),
  p_timezone: text(req.body.timezone, 64).trim() || 'UTC'
})));

// Accounts: platform, handle and profile link. Never passwords or tokens.
app.get('/accounts', handle((req) =>
  rows(social(req).from('accounts').select('*').eq('tenant_id', req.tenantId).order('platform').order('handle'))));

app.post('/accounts', callSocial('save_account', (req) => {
  const fields = accountFields(req.body);
  if (!fields.platform) throw new Error('Choose a platform');
  return { p_account: null, p_data: fields };
}, 201));
app.put('/accounts/:id', callSocial('save_account', (req) => ({
  p_account: id(req.params.id, 'Account'),
  p_data: accountFields(req.body)
})));
app.delete('/accounts/:id', callSocial('delete_account', (req) => ({ p_account: id(req.params.id, 'Account') })));

// Posts. The calendar asks for a date range; the list can include posts with no date yet.
app.get('/posts', handle(async (req) => {
  const { from, to, status, campaign, tag, assigned_to: assignedTo, account_id: accountId } = req.query;
  let query = social(req).from('posts').select(POST_FIELDS).eq('tenant_id', req.tenantId);
  if (from || to) {
    const start = when(from);
    const end = when(to);
    if (!start || !end) throw new Error('Choose a start and end date');
    query = query.gte('scheduled_at', start).lt('scheduled_at', end);
  }
  if (req.query.undated === '1') query = query.is('scheduled_at', null);
  if (status) {
    if (!STATUSES.includes(status)) throw new Error('Choose a status');
    query = query.eq('status', status);
  }
  if (campaign) query = query.eq('campaign', text(campaign, 100));
  if (tag) query = query.contains('tags', [text(tag, 50).toLowerCase()]);
  if (assignedTo) query = query.eq('assigned_to', id(assignedTo, 'Person'));
  const posts = await rows(query.order('scheduled_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false }).limit(500));
  if (!accountId) return posts;
  const account = id(accountId, 'Account');
  return posts.filter((post) => post.targets.some((target) => target.account_id === account));
}));

app.get('/posts/:id', handle(async (req) => {
  const found = await rows(social(req).from('posts').select(POST_FIELDS)
    .eq('tenant_id', req.tenantId).eq('id', id(req.params.id, 'Post')));
  if (!found.length) {
    const error = new Error('Post not found');
    error.status = 404;
    throw error;
  }
  return found[0];
}));

app.post('/posts', callSocial('save_post', (req) => ({ p_post: null, p_data: postFields(req.body) }), 201));
app.put('/posts/:id', callSocial('save_post', (req) => ({ p_post: id(req.params.id, 'Post'), p_data: postFields(req.body) })));
app.delete('/posts/:id', callSocial('delete_post', (req) => ({ p_post: id(req.params.id, 'Post') })));

app.post('/posts/:id/submit', callSocial('submit_post', (req) => ({ p_post: id(req.params.id, 'Post') })));
app.post('/posts/:id/decide', callSocial('decide_post', (req) => ({
  p_post: id(req.params.id, 'Post'),
  p_approve: req.body.approve === true,
  p_note: text(req.body.note, 500).trim() || null
})));
app.post('/posts/:id/draft', callSocial('to_draft', (req) => ({ p_post: id(req.params.id, 'Post') })));

// Recording that someone posted to an account from the platform, with the live link
app.post('/targets/:id/posted', callSocial('mark_posted', (req) => ({
  p_target: id(req.params.id, 'Account on this post'),
  p_url: text(req.body.post_url, 500).trim()
})));
app.delete('/targets/:id/posted', callSocial('unmark_posted', (req) => ({ p_target: id(req.params.id, 'Account on this post') })));

// Results typed in from the platform: likes, comments, shares, clicks and views. Empty clears one.
app.put('/targets/:id/stats', callSocial('save_stats', (req) => {
  const data = {};
  for (const field of ['likes', 'comments', 'shares', 'clicks', 'views']) {
    const value = text(req.body[field], 12).replace(/[\s,]/g, '');
    if (value && !/^\d{1,10}$/.test(value)) throw new Error('Results are whole numbers');
    data[field] = value;
  }
  return { p_target: id(req.params.id, 'Account on this post'), p_data: data };
}));

// Copy a post (no date), or repeat it: { every: 'day' | 'week' | 'month', count: 1..12 }
app.post('/posts/:id/copy', callSocial('copy_post', (req) => {
  const every = ['day', 'week', 'month'].includes(req.body.every) ? req.body.every : null;
  const count = every ? Number(req.body.count) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('Make 1 to 12 repeats at a time');
  return { p_post: id(req.params.id, 'Post'), p_every: every, p_count: count };
}, 201));

// Comments on a post
app.get('/posts/:id/comments', handle((req) =>
  rows(social(req).from('post_comments').select('id, author_id, body, created_at')
    .eq('tenant_id', req.tenantId).eq('post_id', id(req.params.id, 'Post')).order('id').limit(200))));
app.post('/posts/:id/comments', callSocial('add_comment', (req) => {
  const body = text(req.body.body, 1001).trim();
  if (!body || body.length > 1000) throw new Error('Write a comment of up to 1000 characters');
  return { p_post: id(req.params.id, 'Post'), p_body: body };
}, 201));
app.delete('/comments/:id', callSocial('delete_comment', (req) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw new Error('Comment not found');
  return { p_comment: req.params.id };
}));

// Content library: saved text and hashtag sets
app.get('/snippets', handle((req) =>
  rows(social(req).from('snippets').select('id, kind, name, body, created_by, updated_at')
    .eq('tenant_id', req.tenantId).order('kind').order('name').limit(300))));
const snippetFields = (body) => ({
  kind: ['text', 'hashtags'].includes(body.kind) ? body.kind : null,
  name: text(body.name, 100).trim(),
  body: text(body.body, 3000).trim()
});
app.post('/snippets', callSocial('save_snippet', (req) => ({ p_snippet: null, p_data: snippetFields(req.body) }), 201));
app.put('/snippets/:id', callSocial('save_snippet', (req) => ({ p_snippet: id(req.params.id, 'Library item'), p_data: snippetFields(req.body) })));
app.delete('/snippets/:id', callSocial('delete_snippet', (req) => ({ p_snippet: id(req.params.id, 'Library item') })));

// When posts do best, from the company's own posted history. ?platform=x|linkedin|facebook|instagram
app.get('/best-times', callSocial('best_times', (req) => ({
  p_platform: PLATFORMS.includes(req.query.platform) ? req.query.platform : null
})));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Bad JSON and too-large bodies are the sender's mistake, not ours
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.status === 413 ? 'That is too large to send' : 'That request could not be read' });
  }
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

app.listen(PORT, () => console.log(`📱 Social Media Service on ${PORT}`));
