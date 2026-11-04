require('dotenv').config();
const crypto = require('crypto');
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
  + 'contact_id, campaign, staff_unread, visitor_messages, last_message, last_message_at, created_at, closed_at, '
  + 'rating, rating_comment, rated_at, visitor_typing_at, channel, visitor_phone, last_visitor_at';
const TICKET_STATUSES = ['new', 'in_progress', 'waiting', 'solved'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TICKET_FIELDS = 'id, number, subject, description, status, priority, assigned_to, conversation_id, contact_id, '
  + 'customer_name, customer_email, due_at, solved_at, created_by, created_at, updated_at';
// The visitor counts as typing for a few seconds after the chat page last said so
const TYPING_MS = 6000;
const typingNow = (value) => Boolean(value) && Date.now() - Date.parse(value) < TYPING_MS;

const chat = (req) => req.db.schema('chat');

// Only our own messages and the ones our database functions raise (P0001) reach people
const sendError = (res, error) => {
  const code = error?.code || '';
  if (error?.status) return res.status(error.status).json({ error: error.message });
  if (!code && error?.constructor === Error) return res.status(400).json({ error: error.message });
  if (code === 'P0001') return res.status(400).json({ error: error.message });
  if (/^PT[45]\d\d$/.test(code)) return res.status(Number(code.slice(2))).json({ error: error.message });

  console.error('Chat error:', error);
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

// Characters that would change a PostgREST .or() filter or act as wildcards
const searchText = (value) => text(value, 100).replace(/[%_,()*\\"]/g, ' ').trim();

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

// ---- WhatsApp (Business Cloud API) ----
// Switched on by WHATSAPP_TOKEN (sending) and WHATSAPP_APP_SECRET (checking Meta's signature).
// WHATSAPP_PHONE_NUMBER_ID is the number used when a company hasn't saved its own.
// Which company a number belongs to is saved in each company's chat settings.
const GRAPH_URL = 'https://graph.facebook.com/v21.0';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_CLOSED = 'It has been more than 24 hours since this customer last wrote. WhatsApp only allows a '
  + 'pre-approved template message now, so this reply was not sent. Ask them to message you again, or contact them another way.';

const whatsappReady = () => Boolean(process.env.WHATSAPP_TOKEN);

// The same check the gateway makes: HMAC SHA-256 of the raw body with the app secret
const signatureMatches = (raw, header) => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // the database checks it again with its own copy
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
  const given = Buffer.from(String(header || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

const publicDb = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Meta's message, in words for the team. The access token never goes in a message or the logs.
const graphError = (payload, status) => {
  const error = payload?.error || {};
  if (error.code === 131047) return WINDOW_CLOSED;
  if (error.code === 190 || status === 401) return 'The WhatsApp access token has expired or is wrong. Ask whoever set up WhatsApp to renew it.';
  if (error.code === 131026) return 'This number can’t receive WhatsApp messages.';
  if (error.code === 100 && /phone number/i.test(error.message || '')) return 'WhatsApp doesn’t recognise the phone number ID in chat settings.';
  const detail = error.error_data?.details || error.message;
  return detail ? `WhatsApp didn’t send it: ${String(detail).slice(0, 200)}` : 'WhatsApp didn’t send it. Please try again.';
};

const sendWhatsApp = async (phoneNumberId, to, body) => {
  let response;
  try {
    response = await fetch(`${GRAPH_URL}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body } }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    return { error: 'WhatsApp could not be reached. Please try again.' };
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('WhatsApp send failed:', response.status, payload?.error?.code, payload?.error?.message);
    return { error: graphError(payload, response.status) };
  }
  return { id: payload?.messages?.[0]?.id || null };
};

// Meta's webhook, forwarded by the gateway with the raw body and signature. Before the JSON
// parser and the tenant check: there is no signed-in user, and the database finds the company
// from the phone number id and checks the signature again.
app.post('/whatsapp/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const signature = req.headers['x-hub-signature-256'];
  if (!raw.length || !signatureMatches(raw, signature)) return res.status(401).json({ error: 'The signature does not match' });
  const { data, error } = await publicDb().rpc('whatsapp_receive', { p_body: raw.toString('utf8'), p_signature: String(signature || '') });
  if (error) {
    if (error.code === 'P0001' && /signature/i.test(error.message)) return res.status(401).json({ error: error.message });
    console.error('WhatsApp webhook error:', error.code, error.message);
    // Anything else is worth Meta trying again
    return res.status(error.code === 'P0001' ? 400 : 500).json({ error: error.code === 'P0001' ? error.message : 'Could not save the message' });
  }
  res.json(data);
});
// ---- End of WhatsApp webhook ----

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
  const search = searchText(req.query.q);
  if (search) {
    const digits = search.replace(/\D/g, '');
    query = query.or(`visitor_name.ilike.%${search}%,visitor_email.ilike.%${search}%,last_message.ilike.%${search}%`
      + (digits.length >= 4 ? `,visitor_phone.like.%${digits}%` : ''));
  }
  return rows(query.order('last_message_at', { ascending: false }).limit(200));
}));

// One conversation with its messages. ?after=<message id> returns only newer messages, for polling.
app.get('/conversations/:id', handle(async (req) => {
  const conversationId = id(req.params.id, 'Chat');
  const after = Number.isSafeInteger(Number(req.query.after)) ? Number(req.query.after) : 0;
  const messageQuery = chat(req).from('messages').select('id, sender, author_id, answer_id, body, created_at, wa_status, send_error')
    .eq('tenant_id', req.tenantId).eq('conversation_id', conversationId);
  const [found, messages] = await Promise.all([
    rows(chat(req).from('conversations').select(CONVERSATION_FIELDS).eq('tenant_id', req.tenantId).eq('id', conversationId)),
    rows(after > 0
      ? messageQuery.gt('id', after).order('id').limit(500)
      : messageQuery.order('id', { ascending: false }).limit(500))
  ]);
  if (!found.length) throw notFound('Chat not found');
  // The linked CRM contact's name, for "Linked to ..."
  let contact = null;
  if (found[0].contact_id) {
    const linked = await rows(req.db.schema('crm').from('contacts').select('id, name, email')
      .eq('tenant_id', req.tenantId).eq('id', found[0].contact_id));
    contact = linked[0] || null;
  }
  // Unsolved tickets made from this chat
  const tickets = await rows(chat(req).from('tickets').select('id, number, status')
    .eq('tenant_id', req.tenantId).eq('conversation_id', conversationId).neq('status', 'solved').limit(5));
  const { visitor_typing_at: typingAt, ...conversation } = found[0];
  return {
    ...conversation, contact, tickets, visitor_typing: typingNow(typingAt),
    messages: after > 0 ? messages : messages.reverse()
  };
}));

// Staff are typing a reply; the visitor sees "typing..."
app.post('/conversations/:id/typing', async (req, res) => {
  try {
    await call(req, 'typing', { p_conversation: id(req.params.id, 'Chat') });
  } catch {
    // Not worth an error
  }
  res.json({ success: true });
});

// A chat becomes a ticket, or gives back its unsolved one
app.post('/conversations/:id/ticket', callChat('ticket_from_chat', (req) => ({
  p_conversation: id(req.params.id, 'Chat'),
  p_priority: PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal'
}), 201));

// CRM contacts to link a chat to. ?q=name or email
app.get('/contacts', handle((req) => {
  const search = searchText(req.query.q);
  let query = req.db.schema('crm').from('contacts').select('id, name, email').eq('tenant_id', req.tenantId);
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  return rows(query.order('name').limit(20));
}));

// Link the chat to a CRM contact, or unlink it with contact_id null
app.post('/conversations/:id/contact', callChat('link_contact', (req) => ({
  p_conversation: id(req.params.id, 'Chat'),
  p_contact: req.body.contact_id ? id(req.body.contact_id, 'Contact') : null
})));

// Viewers can read but not mark read; that is not an error for them
app.post('/conversations/:id/read', async (req, res) => {
  try {
    await call(req, 'mark_read', { p_conversation: id(req.params.id, 'Chat') });
  } catch {
    // Unread counts stay as they are
  }
  res.json({ success: true });
});

// A reply on a WhatsApp chat is also sent through WhatsApp, inside its 24-hour window
app.post('/conversations/:id/reply', async (req, res) => {
  try {
    const conversationId = id(req.params.id, 'Chat');
    const body = text(req.body.body, 2001).trim();
    if (!body) throw new Error('Type a reply');
    if (body.length > 2000) throw new Error('Replies can be up to 2000 characters');

    const found = await rows(chat(req).from('conversations').select('id, channel, visitor_phone, last_visitor_at')
      .eq('tenant_id', req.tenantId).eq('id', conversationId));
    if (!found.length) throw notFound('Chat not found');
    const convo = found[0];
    if (convo.channel !== 'whatsapp') {
      return res.status(201).json(await call(req, 'reply', { p_conversation: conversationId, p_body: body }));
    }

    if (!whatsappReady()) throw new Error('WhatsApp isn’t switched on for this app yet, so this reply was not sent.');
    if (!convo.visitor_phone) throw new Error('This WhatsApp chat has no phone number, so the reply was not sent.');
    if (!convo.last_visitor_at || Date.now() - Date.parse(convo.last_visitor_at) > WINDOW_MS) throw new Error(WINDOW_CLOSED);
    const settings = await rows(chat(req).from('settings').select('whatsapp_phone_number_id').eq('tenant_id', req.tenantId));
    const phoneNumberId = settings[0]?.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) throw new Error('Add your WhatsApp phone number ID in chat settings first, so the reply was not sent.');

    // Saved first (this checks the person may reply), then sent, then marked sent or failed
    const saved = await call(req, 'reply', { p_conversation: conversationId, p_body: body });
    const sent = await sendWhatsApp(phoneNumberId, convo.visitor_phone, body);
    try {
      await call(req, 'whatsapp_sent', { p_message: saved.id, p_wamid: sent.id || null, p_error: sent.error || null });
    } catch (error) {
      console.error('WhatsApp status not saved:', error.code, error.message);
    }
    res.status(201).json({ ...saved, wa_status: sent.error ? 'failed' : 'sent', whatsapp_error: sent.error || null });
  } catch (error) {
    sendError(res, error);
  }
});

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
  const status = await call(req, 'whatsapp_status', {}).catch(() => ({}));
  return {
    ...data[0],
    whatsapp: {
      // This app can send (access token) and check Meta's signature (app secret, here and in the database)
      app_ready: whatsappReady() && Boolean(process.env.WHATSAPP_APP_SECRET) && Boolean(status.secret_saved),
      can_send: whatsappReady(),
      secret_saved: Boolean(status.secret_saved),
      last_received_at: status.last_received_at || null
    }
  };
}));

// The customer's own reschedule/cancel link for a booking, to send them in a WhatsApp reminder
app.get('/whatsapp/booking-link/:id', callChat('booking_link_token', (req) => ({ p_booking: id(req.params.id, 'Booking') })));

app.put('/settings', callChat('save_settings', (req) => {
  const data = {};
  for (const field of ['enabled', 'bot_enabled', 'hours_enabled', 'ask_rating']) {
    if (req.body[field] !== undefined) data[field] = Boolean(req.body[field]);
  }
  if (req.body.hours_timezone !== undefined) data.hours_timezone = text(req.body.hours_timezone, 64).trim();
  // The database checks the times and targets themselves
  if (req.body.weekly_hours !== undefined) {
    if (!Array.isArray(req.body.weekly_hours) || req.body.weekly_hours.length !== 7) throw new Error('Give opening hours for each day of the week');
    data.weekly_hours = req.body.weekly_hours.map((day) => (day && typeof day === 'object'
      ? { from: text(day.from, 5), to: text(day.to, 5) } : null));
  }
  if (req.body.sla_hours !== undefined) {
    const sla = req.body.sla_hours || {};
    data.sla_hours = Object.fromEntries(PRIORITIES.map((level) => [level, text(sla[level], 4).trim() || '0']));
  }
  for (const [field, max] of [['welcome_message', 500], ['handoff_message', 500], ['offline_message', 500], ['opening_hours', 200]]) {
    if (req.body[field] === undefined) continue;
    const value = text(req.body[field], max + 1).trim();
    if (value.length > max) throw new Error(`That message can be up to ${max} characters`);
    data[field] = value;
  }
  if (req.body.colour !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(req.body.colour)) throw new Error('Choose a colour');
    data.colour = req.body.colour;
  }
  // Empty disconnects WhatsApp; the database checks the digits and that no other company has it
  if (req.body.whatsapp_phone_number_id !== undefined) {
    data.whatsapp_phone_number_id = text(req.body.whatsapp_phone_number_id, 40).replace(/\s/g, '');
  }
  return { p_data: data };
}));

app.post('/settings/key', callChat('new_key', () => ({})));

// Saved replies, typed as /shortcut in the reply box
app.get('/canned', handle((req) =>
  rows(chat(req).from('canned_replies').select('id, shortcut, body, created_by, updated_at')
    .eq('tenant_id', req.tenantId).order('shortcut').limit(200))));
const cannedFields = (req) => {
  const shortcut = text(req.body.shortcut, 40).trim().replace(/^\/+/, '').toLowerCase();
  const body = text(req.body.body, 2001).trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(shortcut)) throw new Error('Shortcuts are up to 30 letters, numbers, - or _, with no spaces');
  if (!body || body.length > 2000) throw new Error('Enter the reply, up to 2000 characters');
  return { p_shortcut: shortcut, p_body: body };
};
app.post('/canned', callChat('save_canned', (req) => ({ p_reply: null, ...cannedFields(req) }), 201));
app.put('/canned/:id', callChat('save_canned', (req) => ({ p_reply: id(req.params.id, 'Saved reply'), ...cannedFields(req) })));
app.delete('/canned/:id', callChat('delete_canned', (req) => ({ p_reply: id(req.params.id, 'Saved reply') })));

// Ratings visitors gave. ?days=7..365 (default 30)
app.get('/ratings', callChat('rating_stats', (req) => {
  const days = Number(req.query.days);
  return { p_days: Number.isInteger(days) ? Math.min(Math.max(days, 1), 365) : 30 };
}));

// Tickets. ?status=open (default: not solved)|new|in_progress|waiting|solved|all, ?mine=1&me=, ?overdue=1, ?q=
app.get('/tickets', handle((req) => {
  let query = chat(req).from('tickets').select(TICKET_FIELDS).eq('tenant_id', req.tenantId);
  if (TICKET_STATUSES.includes(req.query.status)) query = query.eq('status', req.query.status);
  else if (req.query.status !== 'all') query = query.neq('status', 'solved');
  if (req.query.mine === '1' && UUID.test(req.query.me || '')) query = query.eq('assigned_to', req.query.me);
  if (req.query.overdue === '1') query = query.in('status', ['new', 'in_progress']).lt('due_at', new Date().toISOString());
  if (PRIORITIES.includes(req.query.priority)) query = query.eq('priority', req.query.priority);
  const search = searchText(req.query.q);
  if (search) {
    const number = /^#?\d{1,9}$/.test(search) ? Number(search.replace('#', '')) : null;
    query = query.or(`subject.ilike.%${search}%,customer_name.ilike.%${search}%,customer_email.ilike.%${search}%`
      + (number ? `,number.eq.${number}` : ''));
  }
  return rows(query.order('due_at', { ascending: true, nullsFirst: false }).order('number', { ascending: false }).limit(300));
}));

app.get('/tickets/:id', handle(async (req) => {
  const ticketId = id(req.params.id, 'Ticket');
  const [found, notes] = await Promise.all([
    rows(chat(req).from('tickets').select(TICKET_FIELDS).eq('tenant_id', req.tenantId).eq('id', ticketId)),
    rows(chat(req).from('ticket_notes').select('id, author_id, kind, body, created_at').eq('tenant_id', req.tenantId).eq('ticket_id', ticketId).order('id').limit(200))
  ]);
  if (!found.length) throw notFound('Ticket not found');
  let contact = null;
  if (found[0].contact_id) {
    const linked = await rows(req.db.schema('crm').from('contacts').select('id, name, email')
      .eq('tenant_id', req.tenantId).eq('id', found[0].contact_id));
    contact = linked[0] || null;
  }
  return { ...found[0], contact, notes };
}));

const ticketFields = (body) => {
  const subject = text(body.subject, 201).trim();
  if (!subject || subject.length > 200) throw new Error('Enter a subject, up to 200 characters');
  const description = text(body.description, 4001).trim();
  if (description.length > 4000) throw new Error('Descriptions can be up to 4000 characters');
  if (body.priority && !PRIORITIES.includes(body.priority)) throw new Error('Choose a priority');
  return {
    subject,
    description,
    priority: body.priority || 'normal',
    assigned_to: body.assigned_to ? id(body.assigned_to, 'Team member') : null,
    contact_id: body.contact_id ? id(body.contact_id, 'Contact') : null,
    customer_name: text(body.customer_name, 100).trim(),
    customer_email: text(body.customer_email, 254).trim()
  };
};
app.post('/tickets', callChat('save_ticket', (req) => ({ p_ticket: null, p_data: ticketFields(req.body) }), 201));
app.put('/tickets/:id', callChat('save_ticket', (req) => ({ p_ticket: id(req.params.id, 'Ticket'), p_data: ticketFields(req.body) })));
app.post('/tickets/:id/status', callChat('set_ticket_status', (req) => {
  if (!TICKET_STATUSES.includes(req.body.status)) throw new Error('Choose a status');
  return { p_ticket: id(req.params.id, 'Ticket'), p_status: req.body.status };
}));
app.post('/tickets/:id/notes', callChat('add_ticket_note', (req) => {
  const body = text(req.body.body, 2001).trim();
  if (!body || body.length > 2000) throw new Error('Write a note of up to 2000 characters');
  return { p_ticket: id(req.params.id, 'Ticket'), p_body: body };
}, 201));
app.delete('/tickets/:id', callChat('delete_ticket', (req) => ({ p_ticket: id(req.params.id, 'Ticket') })));

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

app.listen(PORT, () => console.log(`💬 Chat Service on ${PORT}`));
