// The action catalog: the only things an approved idea can do. Each action is checked here before
// an idea is saved and again before it runs, and then runs THROUGH THE GATEWAY AS THE APPROVING
// PERSON (their Authorization and company), so every normal permission check and validation in the
// other services still applies.
//
// Never in the catalog: anything that moves money, deletes, voids, sends external email, changes
// prices or touches payroll amounts. Ideas about those are advice only (no actions).

const { addDays, isoDay, formatMoney, round2, num } = require('./business');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_URL = () => (process.env.APP_URL || 'https://multi-saas-frontend.vercel.app').replace(/\/+$/, '');
const gatewayUrl = () => (process.env.GATEWAY_INTERNAL_URL
  || `http://${process.env.NODE_ENV === 'production' ? 'api-gateway.railway.internal' : 'localhost'}:3000`).replace(/\/+$/, '');

class Invalid extends Error {}
const bad = (message) => { throw new Invalid(message); };

const clean = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const text = (value, max, label, { required = false } = {}) => {
  const out = clean(value);
  if (required && !out) bad(`${label} is missing`);
  if (out.length > max) bad(`${label} is longer than ${max} characters`);
  return out;
};
const id = (value, label) => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : bad(`${label} is not a valid id`));
const whole = (value, min, max, label, fallback) => {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : bad(`${label} must be a whole number from ${min} to ${max}`);
};
const amount = (value, min, max, label) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? round2(n) : bad(`${label} must be a number from ${min} to ${max}`);
};
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : bad('Parameters must be an object'));

// ---- WhatsApp click-to-chat (same rules as frontend/lib/whatsapp.ts) ----
const whatsappNumber = (phone) => {
  const written = String(phone || '').trim();
  let digits = written.replace(/\D/g, '');
  if (!digits) return '';
  if (written.startsWith('+')) return digits.length >= 7 ? digits : '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) return '';
  return digits.length >= 7 && digits.length <= 15 ? digits : '';
};
const whatsappLink = (phone, message) => {
  const number = whatsappNumber(phone);
  const body = String(message || '').trim();
  return `https://wa.me/${number}${body ? `?text=${encodeURIComponent(body)}` : ''}`;
};
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const invoiceWhatsAppText = ({ name, number, total, due, link, company }) => [
  `Hi${firstName(name) ? ` ${firstName(name)}` : ''}, here is invoice ${number || ''}${company ? ` from ${company}` : ''}`.trim()
    + `${total ? ` for ${total}` : ''}${due ? `, due ${due}` : ''}.`,
  link ? `You can view and pay it here: ${link}` : '',
  'Thank you!'
].filter(Boolean).join('\n\n');

// ---- Calling the gateway as the approving person ----
const gateway = async (ctx, method, path, body) => {
  let response;
  try {
    response = await fetch(`${gatewayUrl()}${path}`, {
      method,
      headers: {
        Authorization: ctx.authorization,
        'X-Company': ctx.tenantId,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'That took too long. Please try again.' : 'Get-ly couldn’t be reached. Please try again.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error.length < 300 ? data.error : `That didn’t work (error ${response.status}).`;
    throw new Error(message);
  }
  return data;
};

const TARGETS = { contact: 'contact_id', deal: 'deal_id', lead: 'lead_id' };
const TARGET_PAGES = { contact: 'contact', deal: 'deal', lead: 'lead' };
const ACTIVITY_KINDS = ['task', 'call', 'meeting'];
const GOAL_METRICS = ['revenue', 'cash_in', 'won_value', 'new_leads', 'bookings', 'chats'];

// Each action: what it does (for people and the AI), how to check its parameters, and how to run it
const CATALOG = {
  create_follow_up: {
    label: 'Add a follow-up task in CRM',
    describe: 'Adds a follow-up task (or call/meeting reminder) on a CRM contact, deal or lead. Nothing is sent to anyone.',
    params: '{ target_type: "contact"|"deal"|"lead", target_id: uuid, subject: string (max 200), body?: string (max 2000), due_in_days?: 0-60 (default 1), kind?: "task"|"call"|"meeting" (default "task") }',
    check: (p) => {
      object(p);
      const targetType = TARGETS[p.target_type] ? p.target_type : bad('target_type must be contact, deal or lead');
      return {
        target_type: targetType,
        target_id: id(p.target_id, 'target_id'),
        subject: text(p.subject, 200, 'subject', { required: true }),
        body: text(p.body, 2000, 'body'),
        due_in_days: whole(p.due_in_days, 0, 60, 'due_in_days', 1),
        kind: p.kind === undefined || p.kind === null || p.kind === '' ? 'task' : ACTIVITY_KINDS.includes(p.kind) ? p.kind : bad('kind must be task, call or meeting')
      };
    },
    run: async (ctx, p) => {
      const due = addDays(isoDay(new Date()), p.due_in_days);
      const made = await gateway(ctx, 'POST', '/api/crm/activities', {
        kind: p.kind, subject: p.subject, body: p.body || null, due_on: due, [TARGETS[p.target_type]]: p.target_id
      });
      return {
        message: `Added a ${p.kind === 'task' ? 'follow-up task' : p.kind} “${p.subject}”, due ${due}.`,
        id: made?.id || null,
        link: `/saas/crm/${TARGET_PAGES[p.target_type]}/${p.target_id}`
      };
    }
  },

  create_lead: {
    label: 'Add a lead in CRM',
    describe: 'Adds a new lead to CRM. Nobody is contacted.',
    params: '{ name: string (max 200), email?: string, phone?: string, company_name?: string, source?: string, notes?: string (max 2000) }',
    check: (p) => {
      object(p);
      const email = text(p.email, 254, 'email');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('email is not a valid email address');
      return {
        name: text(p.name, 200, 'name', { required: true }),
        email,
        phone: text(p.phone, 40, 'phone'),
        company_name: text(p.company_name, 200, 'company_name'),
        source: text(p.source, 100, 'source'),
        notes: text(p.notes, 2000, 'notes')
      };
    },
    run: async (ctx, p) => {
      const made = await gateway(ctx, 'POST', '/api/crm/leads', {
        name: p.name, email: p.email || null, phone: p.phone || null, company_name: p.company_name || null,
        source: p.source || 'Business Brain', notes: p.notes || null
      });
      return { message: `Added the lead “${p.name}”.`, id: made?.id || null, link: made?.id ? `/saas/crm/lead/${made.id}` : '/saas/crm/leads' };
    }
  },

  create_payment_link: {
    label: 'Make a payment link for an invoice',
    describe: 'Makes (or reuses) the online payment link for an invoice and prepares a WhatsApp message with it. Nothing is sent: a person opens the WhatsApp link to send it. Needs online payments to be set up.',
    params: '{ invoice_id: uuid }',
    check: (p) => ({ invoice_id: id(object(p).invoice_id, 'invoice_id') }),
    run: async (ctx, p) => {
      const invoice = await gateway(ctx, 'GET', `/api/accounting/invoices/${p.invoice_id}`);
      const { token } = await gateway(ctx, 'POST', `/api/accounting/invoices/${p.invoice_id}/payment-link`, {});
      if (!/^[0-9a-f]{64}$/.test(token || '')) throw new Error('The payment link could not be made.');
      const link = `${APP_URL()}/pay/${token}`;
      let phone = null;
      let name = invoice?.customer_name || null;
      if (invoice?.customer_id) {
        const customers = await gateway(ctx, 'GET', '/api/accounting/customers').catch(() => []);
        const customer = Array.isArray(customers) ? customers.find((row) => row.id === invoice.customer_id) : null;
        phone = customer?.phone || null;
        name = customer?.name || name;
      }
      const owed = round2(num(invoice?.amount) - num(invoice?.amount_paid) - num(invoice?.amount_credited));
      const message = invoiceWhatsAppText({
        name, number: invoice?.invoice_number, total: owed > 0 ? formatMoney(owed, invoice?.currency) : null,
        due: invoice?.due_date || null, link, company: ctx.companyName || null
      });
      const hasNumber = Boolean(whatsappNumber(phone));
      return {
        message: `Payment link ready for invoice ${invoice?.invoice_number || ''}.`.replace(' .', '.')
          + (hasNumber ? ' Open the WhatsApp link to send it to the customer.' : ' The customer has no usable phone number, so the WhatsApp link will ask who to send it to.'),
        link,
        whatsapp_link: whatsappLink(phone, message),
        whatsapp_message: message
      };
    }
  },

  create_draft_reorder: {
    label: 'Draft purchase orders to restock',
    describe: 'Makes DRAFT purchase orders (one per supplier) through inventory reordering. Nothing is ordered or paid until someone submits and approves the purchase order.',
    params: '{ lines: [{ item_id: uuid, vendor_id: uuid, quantity: 1-100000, unit_price: number >= 0 }] (1-50 lines), expected_in_days?: 1-120 }',
    check: (p) => {
      object(p);
      if (!Array.isArray(p.lines) || p.lines.length < 1 || p.lines.length > 50) bad('lines must list 1 to 50 items');
      return {
        lines: p.lines.map((line, index) => {
          object(line);
          return {
            item_id: id(line.item_id, `lines[${index}].item_id`),
            vendor_id: id(line.vendor_id, `lines[${index}].vendor_id`),
            quantity: whole(line.quantity, 1, 100000, `lines[${index}].quantity`),
            unit_price: amount(line.unit_price ?? 0, 0, 100000000, `lines[${index}].unit_price`)
          };
        }),
        expected_in_days: whole(p.expected_in_days, 1, 120, 'expected_in_days', 14)
      };
    },
    run: async (ctx, p) => {
      const made = await gateway(ctx, 'POST', '/api/inventory/reorder', {
        lines: p.lines, expected_date: addDays(isoDay(new Date()), p.expected_in_days)
      });
      const orders = Array.isArray(made) ? made : [];
      const numbers = orders.map((order) => order.po_number).filter(Boolean);
      return {
        message: `Made ${orders.length === 1 ? 'a draft purchase order' : `${orders.length} draft purchase orders`}${numbers.length ? ` (${numbers.join(', ')})` : ''}. Check and submit ${orders.length === 1 ? 'it' : 'them'} when you’re ready.`,
        ids: orders.map((order) => order.id),
        link: '/saas/accounting/purchase-orders'
      };
    }
  },

  create_draft_social_post: {
    label: 'Draft a social media post',
    describe: 'Adds a DRAFT post to the social media planner with suggested text in its notes. Nothing is published.',
    params: '{ title: string (max 200), text: string (max 2000, the suggested post), scheduled_at?: ISO date-time within a year, campaign?: string (max 100) }',
    check: (p) => {
      object(p);
      let scheduled = null;
      if (p.scheduled_at) {
        const at = Date.parse(p.scheduled_at);
        if (Number.isNaN(at) || at < Date.now() || at > Date.now() + 366 * 86400000) bad('scheduled_at must be a future date within a year');
        scheduled = new Date(at).toISOString();
      }
      return {
        title: text(p.title, 200, 'title', { required: true }),
        text: text(p.text, 2000, 'text', { required: true }),
        scheduled_at: scheduled,
        campaign: text(p.campaign, 100, 'campaign')
      };
    },
    run: async (ctx, p) => {
      const made = await gateway(ctx, 'POST', '/api/social-media/posts', {
        title: p.title, campaign: p.campaign || '', notes: `Suggested text from the Business Brain:\n\n${p.text}`.slice(0, 2000),
        scheduled_at: p.scheduled_at, targets: [], tags: []
      });
      return { message: `Added a draft post “${p.title}”. Choose the accounts and write the final text before posting.`, id: made?.id || null, link: '/saas/social' };
    }
  },

  create_goal: {
    label: 'Set a monthly goal',
    describe: 'Sets a monthly goal in Analytics (revenue, cash_in, won_value, new_leads, bookings or chats). Replaces any goal already set for those months.',
    params: '{ metric: "revenue"|"cash_in"|"won_value"|"new_leads"|"bookings"|"chats", month: "YYYY-MM", target: number > 0, months?: 1-12 (default 1) }',
    check: (p) => {
      object(p);
      const metric = GOAL_METRICS.includes(p.metric) ? p.metric : bad(`metric must be one of ${GOAL_METRICS.join(', ')}`);
      const month = typeof p.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])(-01)?$/.test(p.month) ? p.month.slice(0, 7) : bad('month must look like 2026-12');
      const target = amount(p.target, 0.01, 999999999999, 'target');
      return { metric, month, target, months: whole(p.months, 1, 12, 'months', 1) };
    },
    run: async (ctx, p) => {
      await gateway(ctx, 'POST', '/api/analytics/goals', { metric: p.metric, month: `${p.month}-01`, target: p.target, months: p.months });
      return { message: `Set a ${p.metric.replace('_', ' ')} goal of ${p.target} for ${p.month}${p.months > 1 ? ` and the next ${p.months - 1} month${p.months > 2 ? 's' : ''}` : ''}.`, link: '/saas/analytics/goals' };
    }
  },

  assign_chat: {
    label: 'Give a waiting chat to someone',
    describe: 'Assigns a waiting customer chat to a team member so they reply. user_id may be "me" (the person who approves).',
    params: '{ conversation_id: uuid, user_id: uuid | "me" }',
    check: (p) => {
      object(p);
      return {
        conversation_id: id(p.conversation_id, 'conversation_id'),
        user_id: p.user_id === 'me' ? 'me' : id(p.user_id, 'user_id')
      };
    },
    run: async (ctx, p) => {
      const user = p.user_id === 'me' ? ctx.userId : p.user_id;
      if (!user) throw new Error('Nobody to give the chat to.');
      await gateway(ctx, 'POST', `/api/chatbot/conversations/${p.conversation_id}/assign`, { user_id: user });
      return { message: user === ctx.userId ? 'The chat is now yours to answer.' : 'The chat was given to your teammate.', link: `/saas/chat?c=${p.conversation_id}` };
    }
  }
};

const ACTION_TYPES = Object.keys(CATALOG);

// Checks a list of actions. Returns the good ones (cleaned) and plain reasons for the ones dropped.
// knownIds (a Set), when given, limits ids to records the Brain actually showed the AI.
const checkActions = (actions, { knownIds = null } = {}) => {
  const kept = [];
  const dropped = [];
  if (!Array.isArray(actions)) return { kept, dropped: actions ? ['Actions must be a list'] : [] };
  for (const action of actions.slice(0, 10)) {
    const type = action?.type;
    const entry = CATALOG[type];
    if (!entry) {
      dropped.push(`“${String(type).slice(0, 40)}” is not something the Brain can do`);
      continue;
    }
    try {
      const params = entry.check(action.params ?? {});
      if (knownIds) {
        const ids = JSON.stringify(params).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
        const unknown = ids.find((value) => !knownIds.has(value.toLowerCase()));
        if (unknown) throw new Invalid('it points at a record the Brain didn’t look at');
      }
      kept.push({ type, label: entry.label, params });
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      dropped.push(`${entry.label}: ${error.message}`);
    }
  }
  return { kept, dropped };
};

// For the AI prompt and the README
const catalogText = () => ACTION_TYPES.map((type) => `- ${type}: ${CATALOG[type].describe} Params: ${CATALOG[type].params}`).join('\n');
const catalogList = () => ACTION_TYPES.map((type) => ({ type, label: CATALOG[type].label, description: CATALOG[type].describe, params: CATALOG[type].params }));

module.exports = { CATALOG, ACTION_TYPES, checkActions, catalogText, catalogList, whatsappLink, whatsappNumber, invoiceWhatsAppText, gatewayUrl, APP_URL };
