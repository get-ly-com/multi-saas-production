require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3004;

// Staff side of customer chat. Queries run as the signed-in user, so database policies apply;
// every change goes through a chat.* database function that checks the user's role.
// Visitors never reach this service: they use the gateway's public /api/chat/:key routes.
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['open', 'waiting', 'closed'];
// The token column is not readable by staff, so it is never listed here
const CONVERSATION_FIELDS = 'id, status, visitor_name, visitor_email, started_on, wants_person, assigned_to, lead_id, '
  + 'staff_unread, visitor_messages, last_message, last_message_at, created_at, closed_at';

const chat = (req) => req.db.schema('chat');

const sendError = (res, error) => {
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === '23505') return res.status(409).json({ error: 'That is already saved' });
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

const call = async (req, name, params) => {
  const { data, error } = await chat(req).rpc(name, { p_tenant: req.tenantId, ...params });
  if (error) throw error;
  return data ?? { success: true };
};

const callChat = (name, params, status = 200) => async (req, res) => {
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

const notFound = (message) => {
  const error = new Error(message);
  error.status = 404;
  return error;
};

const answerFields = (body) => {
  const question = text(body.question, 301).trim();
  const answer = text(body.answer, 4001).trim();
  if (!question) throw new Error('Enter the question');
  if (question.length > 300) throw new Error('Questions can be up to 300 characters');
  if (!answer) throw new Error('Enter the answer');
  if (answer.length > 4000) throw new Error('Answers can be up to 4000 characters');
  const keywords = text(body.keywords, 501).split(',').map((word) => word.trim()).filter(Boolean).join(', ');
  if (keywords.length > 500) throw new Error('Keywords can be up to 500 characters');
  const data = { question, answer, keywords, is_active: body.is_active === undefined ? true : Boolean(body.is_active) };
  if (body.unanswered_id && UUID.test(body.unanswered_id)) data.unanswered_id = body.unanswered_id;
  return data;
};

app.use(express.json({ limit: '64kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'chatbot-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

app.get('/overview', callChat('overview', () => ({})));
app.get('/team', callChat('team', () => ({})));

// Inbox. ?status=open|waiting|closed (default: everything not closed), ?mine=1, ?q=search
app.get('/conversations', handle((req) => {
  let query = chat(req).from('conversations').select(CONVERSATION_FIELDS).eq('tenant_id', req.tenantId);
  if (req.query.status === 'all') {
    // no filter
  } else if (STATUSES.includes(req.query.status)) {
    query = query.eq('status', req.query.status);
  } else {
    query = query.neq('status', 'closed');
  }
  if (req.query.mine === '1' && UUID.test(req.query.me || '')) query = query.eq('assigned_to', req.query.me);
  const search = text(req.query.q, 100).replace(/[%_,()*\\]/g, ' ').trim();
  if (search) query = query.or(`visitor_name.ilike.%${search}%,visitor_email.ilike.%${search}%,last_message.ilike.%${search}%`);
  return rows(query.order('last_message_at', { ascending: false }).limit(200));
}));

// One conversation with its messages. ?after=<message id> returns only newer messages, for polling.
app.get('/conversations/:id', handle(async (req) => {
  const conversationId = id(req.params.id, 'Chat');
  const after = Number.isSafeInteger(Number(req.query.after)) ? Number(req.query.after) : 0;
  const messageQuery = chat(req).from('messages').select('id, sender, author_id, answer_id, body, created_at')
    .eq('conversation_id', conversationId);
  const [found, messages] = await Promise.all([
    rows(chat(req).from('conversations').select(CONVERSATION_FIELDS).eq('tenant_id', req.tenantId).eq('id', conversationId)),
    rows(after > 0
      ? messageQuery.gt('id', after).order('id').limit(500)
      : messageQuery.order('id', { ascending: false }).limit(500))
  ]);
  if (!found.length) throw notFound('Chat not found');
  return { ...found[0], messages: after > 0 ? messages : messages.reverse() };
}));

// Viewers can read but not mark read; that is not an error for them
app.post('/conversations/:id/read', async (req, res) => {
  try {
    await call(req, 'mark_read', { p_conversation: id(req.params.id, 'Chat') });
  } catch {
    // Unread counts stay as they are
  }
  res.json({ success: true });
});

app.post('/conversations/:id/reply', callChat('reply', (req) => {
  const body = text(req.body.body, 2001).trim();
  if (!body) throw new Error('Type a reply');
  if (body.length > 2000) throw new Error('Replies can be up to 2000 characters');
  return { p_conversation: id(req.params.id, 'Chat'), p_body: body };
}, 201));

app.post('/conversations/:id/assign', callChat('assign', (req) => ({
  p_conversation: id(req.params.id, 'Chat'),
  p_user: req.body.user_id ? id(req.body.user_id, 'Team member') : null
})));

app.post('/conversations/:id/status', callChat('set_status', (req) => {
  if (!['open', 'closed'].includes(req.body.status)) throw new Error('Choose open or closed');
  return { p_conversation: id(req.params.id, 'Chat'), p_status: req.body.status };
}));

app.post('/conversations/:id/lead', callChat('make_lead', (req) => ({ p_conversation: id(req.params.id, 'Chat') }), 201));

// Knowledge base
app.get('/answers', handle((req) =>
  rows(chat(req).from('answers').select('id, question, answer, keywords, is_active, times_used, last_used_at, created_at, updated_at')
    .eq('tenant_id', req.tenantId).order('question').limit(500))));

app.post('/answers', callChat('save_answer', (req) => ({ p_answer: null, p_data: answerFields(req.body) }), 201));
app.put('/answers/:id', callChat('save_answer', (req) => ({ p_answer: id(req.params.id, 'Answer'), p_data: answerFields(req.body) })));
app.delete('/answers/:id', callChat('delete_answer', (req) => ({ p_answer: id(req.params.id, 'Answer') })));

app.post('/answers/test', callChat('test_bot', (req) => {
  const message = text(req.body.text, 1001).trim();
  if (!message) throw new Error('Type a question to try');
  if (message.length > 1000) throw new Error('Messages can be up to 1000 characters');
  return { p_text: message };
}));

// Questions the bot couldn't answer, most asked first
app.get('/unanswered', handle((req) =>
  rows(chat(req).from('unanswered').select('id, question, times, conversation_id, first_asked_at, last_asked_at')
    .eq('tenant_id', req.tenantId).order('times', { ascending: false }).order('last_asked_at', { ascending: false }).limit(200))));

app.delete('/unanswered/:id', callChat('dismiss_unanswered', (req) => ({ p_question: id(req.params.id, 'Question') })));

// Settings. Everyone can read; owners and admins change them.
app.get('/settings', handle(async (req) => {
  const data = await rows(chat(req).from('settings').select('*').eq('tenant_id', req.tenantId));
  if (!data.length) throw notFound('Chat settings not found');
  return data[0];
}));

app.put('/settings', callChat('save_settings', (req) => {
  const data = {};
  for (const field of ['enabled', 'bot_enabled']) {
    if (req.body[field] !== undefined) data[field] = Boolean(req.body[field]);
  }
  for (const [field, max] of [['welcome_message', 500], ['handoff_message', 500], ['opening_hours', 200]]) {
    if (req.body[field] === undefined) continue;
    const value = text(req.body[field], max + 1).trim();
    if (value.length > max) throw new Error(`That message can be up to ${max} characters`);
    data[field] = value;
  }
  if (req.body.colour !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(req.body.colour)) throw new Error('Choose a colour');
    data.colour = req.body.colour;
  }
  return { p_data: data };
}));

app.post('/settings/key', callChat('new_key', () => ({})));

app.listen(PORT, () => console.log(`💬 Chat Service on ${PORT}`));
