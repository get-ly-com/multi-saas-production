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
const POST_FIELDS = '*, targets:post_targets(id, account_id, platform, body, posted_at, post_url, posted_by, account:accounts(id, platform, handle, profile_url, is_active))';

const sendError = (res, error) => {
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === '42501') return res.status(403).json({ error: 'You don’t have access to that' });
  res.status(400).json({ error: error.message });
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
app.get('/overview', handle(async (req) => ({ ...(await call(req, 'overview', {})), tenant_id: req.tenantId })));

// Alerts people about posts due today. The planner calls it when it opens.
app.post('/check-due', callSocial('check_due', () => ({})));

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

app.listen(PORT, () => console.log(`📱 Social Media Service on ${PORT}`));
