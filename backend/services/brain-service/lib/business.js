// Shared business logic for the analytics assistant and the Business Brain: turning company rows
// into the ranked "to do" list, shaping the company snapshot, and calling Claude.
//
// This file is kept identical in two places, because Railway builds each service from its own folder:
//   backend/services/analytics-service/business.js   (the source)
//   backend/services/brain-service/lib/business.js   (a copy)
// After changing it, copy it across and run `npm run check-shared` in brain-service.
//
// Nothing here reads the database. Callers fetch rows (the analytics assistant as the signed-in
// person, the Brain through brain.company_facts) and pass them in, so both show the same thing.

const DAY = 24 * 60 * 60 * 1000;

// How long a restock usually takes. Items have no lead time of their own yet, so one figure is used.
const RESTOCK_DAYS = 14;
const QUIET_DEAL_DAYS = 14;

const userError = (message, status = 400) => Object.assign(new Error(message), { status });

const isoDay = (date) => date.toISOString().slice(0, 10);
const addDays = (day, days) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY));
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const num = (value) => Number(value) || 0;

const formatMoney = (value, currency) => {
  try {
    return Number(value).toLocaleString('en-US', { style: 'currency', currency: currency || 'USD' });
  } catch {
    return `${round2(value).toFixed(2)} ${currency || ''}`.trim();
  }
};

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const weight = (amount) => Math.log10(Math.max(num(amount), 1) + 1) * 4;

// ---- The to do list, one kind at a time ----

// Overdue invoices to chase
const overdueItems = (list, today) => list.map((invoice) => {
  const owed = round2(num(invoice.amount) - num(invoice.amount_paid) - num(invoice.amount_credited));
  if (owed <= 0) return null;
  const late = daysBetween(invoice.due_date, today);
  const who = invoice.customer?.name || invoice.customer_name || 'the customer';
  return {
    kind: 'overdue_invoice',
    title: `Chase ${who} for ${formatMoney(owed, invoice.currency)}`,
    detail: `Invoice ${invoice.invoice_number} is ${plural(late, 'day')} late.`,
    link: `/saas/accounting/invoice/${invoice.id}`,
    link_label: 'Open invoice',
    score: 50 + Math.min(late, 90) / 3 + weight(owed * num(invoice.exchange_rate || 1))
  };
}).filter(Boolean);

// Bank lines that look like a payment for an open invoice or bill: same amount, close in date
const bankMatchItems = (lines, invoices, bills) => {
  const open = [
    ...invoices.map((row) => ({
      type: 'invoice', id: row.id, ref: row.invoice_number, currency: row.currency,
      who: row.customer?.name || row.customer_name || 'a customer',
      owed: round2(num(row.amount) - num(row.amount_paid) - num(row.amount_credited)),
      dates: [row.invoice_date, row.due_date].filter(Boolean)
    })),
    ...bills.map((row) => ({
      type: 'bill', id: row.id, ref: row.bill_number, currency: row.currency,
      who: row.vendor?.name || 'a vendor',
      owed: -round2(num(row.amount) - num(row.amount_paid)),
      dates: [row.bill_date, row.due_date].filter(Boolean)
    }))
  ].filter((row) => row.owed !== 0);

  const used = new Set();
  const found = [];
  for (const line of lines) {
    const amount = round2(line.amount);
    let best = null;
    for (const candidate of open) {
      if (used.has(candidate.id) || Math.abs(candidate.owed - amount) >= 0.005) continue;
      const gap = Math.min(...candidate.dates.map((day) => Math.abs(daysBetween(day, line.line_date))));
      if (gap > 30) continue;
      if (!best || gap < best.gap) best = { candidate, gap };
    }
    if (!best) continue;
    used.add(best.candidate.id);
    const { candidate } = best;
    const money = formatMoney(Math.abs(amount), candidate.currency);
    found.push({
      kind: 'bank_match',
      title: candidate.type === 'invoice'
        ? `Money in of ${money} looks like ${candidate.who} paying ${candidate.ref}`
        : `Money out of ${money} looks like paying ${candidate.who}'s bill ${candidate.ref}`,
      detail: `Bank line on ${line.line_date}${line.description ? `: “${String(line.description).slice(0, 80)}”` : ''}. Check it and match it.`,
      link: '/saas/accounting/banking',
      link_label: 'Match in banking',
      score: 62 - best.gap / 3
    });
  }
  return found;
};

// How much of each item went out per day over the last 30 days. moves: [{item_id, change}] (negative)
const usagePerDay = (moves) => {
  const used = new Map();
  for (const move of moves) used.set(move.item_id, (used.get(move.item_id) || 0) - num(move.change));
  return (itemId) => (used.get(itemId) || 0) / 30;
};

// Items that will run out before a restock could arrive
const runningOutItems = (items, moves) => {
  const perDayOf = usagePerDay(moves);
  return items.map((item) => {
    const perDay = perDayOf(item.id);
    if (perDay <= 0) return null;
    const quantity = Math.max(num(item.quantity), 0);
    const daysLeft = quantity / perDay;
    if (daysLeft > RESTOCK_DAYS) return null;
    const rate = perDay >= 1 ? `about ${Math.round(perDay)} a day` : `about ${Math.max(1, Math.round(perDay * 7))} a week`;
    return {
      kind: 'stock',
      item_id: item.id,
      title: quantity === 0 ? `Reorder ${item.name}: it has run out` : `Reorder ${item.name}: about ${plural(Math.max(1, Math.floor(daysLeft)), 'day')} of stock left`,
      detail: `${quantity} ${item.unit || 'left'} in stock, selling ${rate}. A restock usually takes ${RESTOCK_DAYS} days.`,
      link: '/saas/inventory/reorder',
      link_label: 'Reorder',
      per_day: perDay,
      days_left: daysLeft,
      score: quantity === 0 ? 72 : 56 + (RESTOCK_DAYS - daysLeft)
    };
  }).filter(Boolean);
};

const waited = (since) => {
  const minutes = since ? Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000)) : 0;
  return {
    minutes,
    text: minutes < 60 ? plural(minutes, 'minute') : minutes < 2880 ? plural(Math.round(minutes / 60), 'hour') : plural(Math.round(minutes / 1440), 'day')
  };
};

// Chats waiting for a person
const chatItems = (list) => list.map((chat) => {
  const wait = waited(chat.last_message_at);
  return {
    kind: 'chat',
    chat_id: chat.id,
    title: `Reply to ${chat.visitor_name || chat.visitor_email || 'a website visitor'}`,
    detail: `Waiting for ${wait.text}${chat.last_message ? `: “${String(chat.last_message).slice(0, 80)}”` : ''}`,
    link: `/saas/chat?c=${chat.id}`,
    link_label: 'Open chat',
    score: 80 + Math.min(wait.minutes, 600) / 60
  };
});

// Leave requests someone else made, to decide on
const leaveItems = (list, userId, today) => list
  .filter((request) => !userId || request.employee?.user_id !== userId)
  .map((request) => {
    const who = [request.employee?.first_name, request.employee?.last_name].filter(Boolean).join(' ') || 'Someone';
    const startsIn = daysBetween(today, request.start_date);
    return {
      kind: 'leave',
      title: `Decide on ${who}'s leave`,
      detail: `${plural(num(request.days), 'day')} from ${request.start_date}${startsIn < 0 ? ' (already started)' : startsIn <= 7 ? ` (starts in ${plural(startsIn, 'day')})` : ''}.`,
      link: '/saas/hr/leave',
      link_label: 'Review leave',
      score: 64 + Math.max(0, 14 - Math.max(startsIn, 0))
    };
  });

// Pay runs still in draft for a month that has ended
const payRunItems = (list) => list.map((run) => ({
  kind: 'pay_run',
  pay_run_id: run.id,
  title: `Finish pay run ${run.run_number} for ${String(run.period_start).slice(0, 7)}`,
  detail: 'It is still a draft and that month has ended.',
  link: `/saas/hr/payroll/${run.id}`,
  link_label: 'Open pay run',
  score: 76
}));

// Open deals with nothing logged and no change for two weeks. deals must already exclude ones
// with recent activity.
const quietDealItems = (deals, today, currency) => deals.map((deal) => {
  const last = [deal.updated_at, deal.stage_changed_at, deal.created_at].filter(Boolean).map(String).sort().pop();
  const quiet = last ? daysBetween(last.slice(0, 10), today) : QUIET_DEAL_DAYS;
  return {
    kind: 'quiet_deal',
    deal_id: deal.id,
    quiet_days: quiet,
    title: `Follow up on ${deal.title}`,
    detail: `${num(deal.value) ? `${formatMoney(deal.value, currency)}, ` : ''}${deal.stage?.name || 'open'}, nothing has happened for ${plural(quiet, 'day')}.`,
    link: `/saas/crm/deal/${deal.id}`,
    link_label: 'Open deal',
    score: 30 + Math.min(quiet, 90) / 6 + weight(deal.value)
  };
});

const SECTIONS = {
  overdue_invoice: 'overdue invoices',
  bank_match: 'bank matches',
  stock: 'stock',
  chat: 'chats',
  leave: 'leave',
  pay_run: 'pay runs',
  quiet_deal: 'deals'
};

// Fields only the Brain uses; the to do list leaves them out
const INTERNAL = ['score', 'item_id', 'chat_id', 'deal_id', 'pay_run_id', 'per_day', 'days_left', 'quiet_days'];

// results: [{kind, list, failed}] -> the ranked list the app shows
const rankActions = (results, extra = {}) => {
  const actions = results.flatMap(({ list }) => list)
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)
    .map((action, index) => {
      const shown = { id: `${action.kind}-${index}` };
      for (const [key, value] of Object.entries(action)) if (!INTERNAL.includes(key)) shown[key] = value;
      shown.priority = Math.round(action.score);
      return shown;
    });
  return {
    ...extra,
    actions,
    counts: Object.fromEntries(results.map(({ kind, list }) => [kind, list.length])),
    unavailable: results.filter(({ failed }) => failed).map(({ kind }) => SECTIONS[kind])
  };
};

// ---- The company snapshot ----
const monthBounds = (today) => {
  const [year, month] = today.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  const prevFirst = new Date(Date.UTC(year, month - 2, 1));
  const prevLast = new Date(Date.UTC(year, month - 1, 0));
  const sameDay = new Date(Date.UTC(year, month - 2, Math.min(Number(today.slice(8, 10)), prevLast.getUTCDate())));
  return { from: isoDay(first), to: isoDay(last), prevFrom: isoDay(prevFirst), prevTo: isoDay(prevLast), prevSameDay: isoDay(sameDay) };
};

const TOTALS = ['revenue', 'invoices', 'cash_in', 'cash_out', 'net_cash', 'income', 'expenses', 'profit', 'new_leads', 'won_deals', 'won_value', 'payroll'];
const pickTotals = (totals) => Object.fromEntries(TOTALS.filter((key) => totals?.[key] !== undefined && totals?.[key] !== null).map((key) => [key, totals[key]]));

// rpc(name, params) runs analytics.dashboard / analytics.compare for the company; todo is the to do
// list (or null). Returns the snapshot the assistant and the Brain both reason over.
const buildSnapshot = async (rpc, todoLoader) => {
  const today = isoDay(new Date());
  const bounds = monthBounds(today);
  const [dashboard, lastMonthSoFar, todo] = await Promise.all([
    rpc('dashboard', { p_from: bounds.from, p_to: bounds.to }),
    rpc('compare', { p_from: bounds.prevFrom, p_to: bounds.prevSameDay }),
    todoLoader().catch(() => null)
  ]);

  return {
    today,
    currency: dashboard.currency,
    this_month: { from: bounds.from, to: today, ...pickTotals(dashboard.current) },
    last_month_whole: { from: bounds.prevFrom, to: bounds.prevTo, ...pickTotals(dashboard.previous) },
    last_month_same_days: { from: bounds.prevFrom, to: bounds.prevSameDay, ...pickTotals(lastMonthSoFar?.totals) },
    money_owed_to_us: dashboard.receivables,
    sales_pipeline: dashboard.pipeline,
    stock: dashboard.stock,
    people: dashboard.people,
    top_customers_this_month: (dashboard.top_customers || []).map(({ name, revenue, invoices }) => ({ name, revenue, invoices })),
    top_products_past_year: (dashboard.top_products || []).slice(0, 5),
    last_12_months: (dashboard.trend || []).map(({ month, revenue, profit, cash_in, cash_out }) => ({ month, revenue, profit, cash_in, cash_out })),
    payroll_visible: dashboard.sees_payroll,
    to_do: todo ? { counts: todo.counts, top: todo.actions.slice(0, 8).map(({ title, detail }) => ({ title, detail })) } : null
  };
};

// ---- Claude ----
// Models that can hand a declined request to another model on Anthropic's side
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5-1)$/;

const notSwitchedOn = () => userError('The assistant isn’t switched on yet. Ask whoever runs Get-ly for your company to turn it on.', 503);

// Calls the Messages API and returns the reply's text. A 400 (an optional setting the API doesn't
// accept) is asked once more as a plain request. Only the status and error type are ever logged.
const callClaude = async (body, { model, label = 'Assistant', timeoutMs = 60000, plain = false } = {}) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw notSwitchedOn();
  const fallback = !plain && FALLBACK_MODELS.test(model);
  if (plain) {
    const { output_config, ...rest } = body;
    body = rest;
  }

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {})
      },
      body: JSON.stringify({ model, ...(fallback ? { fallbacks: 'default' } : {}), ...body }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    console.error(`${label} request failed:`, error?.name || 'network error');
    throw userError('The assistant couldn’t be reached. Please try again in a moment.', 502);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`${label} API error:`, response.status, payload?.error?.type || '');
    if (response.status === 401 || response.status === 403) throw notSwitchedOn();
    if (response.status === 429 || response.status === 529) throw userError('The assistant is busy right now. Please try again in a minute.', 503);
    if (response.status === 400 && !plain) return callClaude(body, { model, label, timeoutMs, plain: true });
    throw userError('The assistant couldn’t answer that. Please try again.', 502);
  }
  if (payload?.stop_reason === 'refusal') throw userError('The assistant can’t help with that one.', 422);

  return (payload?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
};

module.exports = {
  DAY, RESTOCK_DAYS, QUIET_DEAL_DAYS,
  userError, isoDay, addDays, daysBetween, round2, num, formatMoney, plural, weight,
  overdueItems, bankMatchItems, usagePerDay, runningOutItems, chatItems, leaveItems, payRunItems, quietDealItems,
  SECTIONS, rankActions,
  monthBounds, pickTotals, buildSnapshot,
  FALLBACK_MODELS, notSwitchedOn, callClaude
};
