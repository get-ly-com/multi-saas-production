// The Brain's rules: fixed checks that work without any AI key. Each finding becomes an idea with
// evidence, pros, cons and risks, and (where the catalog allows) actions a person can approve.

const { daysBetween, formatMoney, round2, num, plural, runningOutItems, quietDealItems, chatItems, isoDay } = require('./business');
const { owedOf } = require('./numbers');

const CONCENTRATION = 0.4;
const EXPENSE_JUMP = 2;
const MAX_OVERDUE_IDEAS = 3;

const idea = (fields) => ({
  source: 'rules',
  effort: 'S',
  pros: [],
  cons: [],
  risks: [],
  actions: [],
  evidence: [],
  ...fields
});

// money owed: overdue invoices, a reminder plus a payment link
const overdueIdeas = (facts) => {
  const today = facts.today;
  const currency = facts.currency;
  return (facts.overdue_invoices || [])
    .map((invoice) => ({ invoice, owed: owedOf(invoice), late: daysBetween(invoice.due_date, today) }))
    .filter(({ owed }) => owed > 0)
    .sort((a, b) => b.owed - a.owed)
    .slice(0, MAX_OVERDUE_IDEAS)
    .map(({ invoice, owed, late }) => {
      const who = invoice.customer?.name || invoice.customer_name || 'the customer';
      const money = formatMoney(owed, currency);
      const actions = [{ type: 'create_payment_link', params: { invoice_id: invoice.id } }];
      if (invoice.contact_id) {
        actions.push({ type: 'create_follow_up', params: {
          target_type: 'contact', target_id: invoice.contact_id, kind: 'call', due_in_days: 0,
          subject: `Ask ${who} about invoice ${invoice.invoice_number}`.slice(0, 200),
          body: `${money} is ${plural(late, 'day')} overdue. Send them the payment link.`
        } });
      }
      return idea({
        dedupe_key: `overdue:${invoice.id}`,
        category: 'cash',
        title: `Get paid for invoice ${invoice.invoice_number}: ${money} from ${who}, ${plural(late, 'day')} late`.slice(0, 200),
        summary: `${who} owes ${money} on invoice ${invoice.invoice_number}, due ${invoice.due_date}. A friendly reminder with a link to pay online usually gets late invoices paid faster.`,
        evidence: [
          { fact: `Still owed on invoice ${invoice.invoice_number}`, number: owed, source: 'Accounting invoices' },
          { fact: 'Days past the due date', number: late, source: 'Accounting invoices' }
        ],
        pros: ['This is money you have already earned.', 'A payment link makes it one click for the customer to pay.'],
        cons: ['A reminder can feel pushy to a good customer if they were about to pay anyway.'],
        risks: [
          'If online payments aren’t set up, making the payment link will fail and you can chase them in the usual way.',
          late > 60 ? 'After this long, the customer may be in trouble; consider whether to keep selling to them on credit.' : 'The customer may dispute the invoice instead of paying it.'
        ],
        expected_impact: { metric: 'invoices_owed', amount: owed, currency, timeframe_days: 14, confidence: late > 60 ? 0.35 : 0.55 },
        actions,
        check_spec: { kind: 'invoices_owed', ids: [invoice.id] }
      });
    });
};

// stock: items that will run out before a restock could arrive, with a draft reorder
const stockIdeas = (facts) => {
  const items = new Map((facts.items || []).map((item) => [item.id, item]));
  const short = runningOutItems(facts.items || [], facts.moves || []);
  if (!short.length) return [];
  const lines = [];
  const noSupplier = [];
  for (const entry of short.slice(0, 50)) {
    const item = items.get(entry.item_id);
    const target = Math.max(num(item.reorder_to), num(item.reorder_level), Math.ceil(entry.per_day * 30));
    const quantity = Math.max(1, Math.ceil(target - Math.max(num(item.quantity), 0)));
    if (item.vendor_id) {
      lines.push({ item_id: item.id, vendor_id: item.vendor_id, quantity, unit_price: round2(num(item.avg_cost)) });
    } else {
      noSupplier.push(item.name);
    }
  }
  const out = short.filter((entry) => Math.max(num(items.get(entry.item_id)?.quantity), 0) === 0).length;
  const names = short.slice(0, 3).map((entry) => items.get(entry.item_id)?.name).filter(Boolean);
  return [idea({
    dedupe_key: 'stock:reorder',
    category: 'stock',
    title: `Restock ${plural(short.length, 'item')} before ${short.length === 1 ? 'it runs' : 'they run'} out`,
    summary: `${names.join(', ')}${short.length > names.length ? ` and ${short.length - names.length} more` : ''} will run out before a normal 14-day restock could arrive, going by the last 30 days of sales.`
      + (lines.length ? ' Approving makes draft purchase orders for the items that have a supplier; nothing is ordered until you submit them.' : '')
      + (noSupplier.length ? ` ${plural(noSupplier.length, 'item')} ha${noSupplier.length === 1 ? 's' : 've'} no supplier set (${noSupplier.slice(0, 3).join(', ')}), so ${noSupplier.length === 1 ? 'it needs' : 'they need'} ordering by hand.` : ''),
    evidence: [
      { fact: 'Items that will run out within 14 days', number: short.length, source: 'Inventory stock and sales' },
      { fact: 'Items already out of stock', number: out, source: 'Inventory stock' }
    ],
    pros: ['Avoids losing sales to empty shelves.', 'Draft orders can be checked and changed before anything is ordered.'],
    cons: ['Money is tied up in stock until it sells.'],
    risks: ['Last month’s sales may not repeat, so you could over-order slow sellers.', 'Supplier prices may have changed since the last purchase.'],
    effort: 'S',
    expected_impact: { metric: 'items_short', amount: short.length, currency: null, timeframe_days: 21, confidence: 0.6 },
    actions: lines.length ? [{ type: 'create_draft_reorder', params: { lines, expected_in_days: 14 } }] : [],
    check_spec: { kind: 'items_short', ids: short.map((entry) => entry.item_id) }
  })];
};

// pipeline: deals with nothing happening, with follow-up tasks
const dealIdeas = (facts) => {
  const quiet = quietDealItems(facts.quiet_deals || [], facts.today, facts.currency)
    .sort((a, b) => b.score - a.score).slice(0, 5);
  if (!quiet.length) return [];
  const deals = new Map((facts.quiet_deals || []).map((deal) => [deal.id, deal]));
  const value = round2(quiet.reduce((total, entry) => total + num(deals.get(entry.deal_id)?.value), 0));
  return [idea({
    dedupe_key: 'deals:quiet',
    category: 'sales',
    title: `Follow up on ${plural(quiet.length, 'quiet deal')}${value ? ` worth ${formatMoney(value, facts.currency)}` : ''}`,
    summary: `Nothing has happened on ${quiet.map((entry) => deals.get(entry.deal_id)?.title).filter(Boolean).slice(0, 3).join(', ')}${quiet.length > 3 ? ' and more' : ''} for at least two weeks. Deals that go quiet are often lost to someone who followed up.`,
    evidence: [
      { fact: 'Open deals with no activity for 14+ days (top ones)', number: quiet.length, source: 'CRM deals and activities' },
      { fact: 'Value of those deals', number: value, source: 'CRM deals' },
      { fact: 'Longest quiet spell in days', number: Math.max(...quiet.map((entry) => entry.quiet_days)), source: 'CRM deals' }
    ],
    pros: ['A short check-in often restarts a stalled deal.', 'Tasks put the follow-up on someone’s list.'],
    cons: ['Takes sales time away from new leads.'],
    risks: ['Some of these deals may already be lost; clearing them out keeps the pipeline honest.'],
    expected_impact: { metric: 'deals_quiet', amount: quiet.length, currency: null, timeframe_days: 14, confidence: 0.5 },
    actions: quiet.map((entry) => ({ type: 'create_follow_up', params: {
      target_type: 'deal', target_id: entry.deal_id, kind: 'task', due_in_days: 1,
      subject: `Follow up: ${deals.get(entry.deal_id)?.title || 'deal'}`.slice(0, 200)
    } })),
    check_spec: { kind: 'deals_quiet', ids: quiet.map((entry) => entry.deal_id) }
  })];
};

// chat: chats waiting for a reply
const chatIdeas = (facts) => {
  const waiting = chatItems(facts.waiting_chats || []).slice(0, 5);
  if (!waiting.length) return [];
  const longest = Math.max(...(facts.waiting_chats || []).slice(0, 5).map((chat) =>
    (chat.last_message_at ? Math.round((Date.now() - Date.parse(chat.last_message_at)) / 60000) : 0)));
  return [idea({
    dedupe_key: 'chat:waiting',
    category: 'operations',
    title: `${plural(waiting.length, 'customer chat')} ${waiting.length === 1 ? 'is' : 'are'} waiting for a reply`,
    summary: 'Customers are waiting in chat and nobody has picked them up. Approving gives these chats to you so you can answer them.',
    evidence: [
      { fact: 'Chats waiting with nobody assigned', number: (facts.waiting_chats || []).length, source: 'Chat' },
      { fact: 'Longest wait in minutes', number: longest, source: 'Chat' }
    ],
    pros: ['Quick replies win sales and keep customers happy.'],
    cons: ['It adds to your own workload; you can pass chats on afterwards.'],
    risks: ['Some visitors may already have left.'],
    expected_impact: { metric: 'chats_waiting', amount: waiting.length, currency: null, timeframe_days: 1, confidence: 0.7 },
    actions: waiting.map((entry) => ({ type: 'assign_chat', params: { conversation_id: entry.chat_id, user_id: 'me' } })),
    check_spec: { kind: 'chats_waiting', ids: waiting.map((entry) => entry.chat_id) }
  })];
};

// cash: a projected dip below zero in the next 90 days
const cashIdeas = (facts, forecast) => {
  if (!forecast?.first_below_zero) return [];
  const money = (v) => formatMoney(v, facts.currency);
  const overdue = round2((facts.overdue_invoices || []).reduce((t, row) => t + Math.max(owedOf(row), 0), 0));
  return [idea({
    dedupe_key: `cash:dip:${forecast.first_below_zero.slice(0, 7)}`,
    category: 'cash',
    effort: 'M',
    title: `Cash may run short around ${forecast.first_below_zero}`,
    summary: `${forecast.warning} This comes from what customers owe you, the bills you owe, recurring invoices and recent payroll. Chasing overdue invoices (${money(overdue)}), agreeing later dates for big bills or arranging a credit line before then would help.`,
    evidence: [
      { fact: 'Cash in bank and cash accounts today', number: forecast.opening_balance, source: 'Accounting ledger' },
      { fact: `Lowest projected balance (on ${forecast.lowest_point.date})`, number: forecast.lowest_point.balance, source: 'Brain cash forecast' },
      { fact: 'Overdue invoices still owed to you', number: overdue, source: 'Accounting invoices' }
    ],
    pros: ['Knowing early gives you time to act calmly.'],
    cons: ['Asking suppliers for more time can strain the relationship.'],
    risks: [
      'The forecast can only see invoices and bills already in Get-ly; other spending would make the dip deeper.',
      'If overdue customers don’t pay, the dip comes sooner.'
    ],
    expected_impact: { metric: 'cash_balance', amount: Math.abs(forecast.lowest_point.balance), currency: facts.currency, timeframe_days: 30, confidence: 0.4 },
    actions: [],
    check_spec: { kind: 'cash_balance' }
  })];
};

// revenue concentration: one customer is over 40% of the last 12 months' revenue
const concentrationIdeas = (facts) => {
  const total = num(facts.customer_revenue?.total);
  const top = facts.customer_revenue?.top?.[0];
  if (!top || total <= 0 || (facts.customer_revenue.top || []).length < 2) return [];
  const share = num(top.revenue) / total;
  if (share <= CONCENTRATION) return [];
  const pct = Math.round(share * 100);
  return [idea({
    dedupe_key: `concentration:${top.customer_id || top.customer}`.slice(0, 200),
    category: 'risk',
    effort: 'L',
    title: `${top.customer} brings in ${pct}% of your revenue`,
    summary: `Over the last 12 months, ${top.customer} paid ${formatMoney(top.revenue, facts.currency)} of your ${formatMoney(total, facts.currency)} revenue. Losing them would hurt badly, so it’s worth winning a few more customers of a similar size.`,
    evidence: [
      { fact: `Revenue from ${top.customer} in the last 12 months`, number: num(top.revenue), source: 'Accounting invoices' },
      { fact: 'Total revenue in the last 12 months', number: total, source: 'Accounting invoices' },
      { fact: 'Share of revenue (%)', number: pct, source: 'Accounting invoices' }
    ],
    pros: ['Spreading revenue across more customers makes the business steadier.'],
    cons: ['Finding new customers takes time and money.'],
    risks: ['A big customer may ask for discounts if they know how much you rely on them.'],
    expected_impact: { metric: 'other', amount: null, currency: facts.currency, timeframe_days: 90, confidence: 0.3 },
    actions: []
  })];
};

// payroll: a draft pay run past its date (advice only; the Brain never touches payroll)
const payrollIdeas = (facts) => (facts.draft_pay_runs || []).slice(0, 2).map((run) => {
  const late = run.pay_date ? daysBetween(run.pay_date, facts.today) : daysBetween(run.period_end, facts.today);
  return idea({
    dedupe_key: `payroll:${run.id}`,
    category: 'people',
    title: `Pay run ${run.run_number} for ${String(run.period_start).slice(0, 7)} is still a draft`,
    summary: `The pay run for ${run.period_start} to ${run.period_end} hasn’t been approved${run.pay_date ? ` and its pay date was ${run.pay_date}` : ''}. Check it and approve it in HR so your team is paid on time. The Brain never changes payroll itself.`,
    evidence: [{ fact: `Days since the ${run.pay_date ? 'pay date' : 'end of the pay period'}`, number: Math.max(late, 0), source: 'HR payroll' }],
    pros: ['Paying people on time keeps trust.'],
    cons: ['Someone needs to check the figures before approving.'],
    risks: ['Late pay can break employment rules in some countries.'],
    expected_impact: { metric: 'other', amount: null, currency: null, timeframe_days: 3, confidence: 0.8 },
    actions: []
  });
});

// expenses: an expense account more than twice its usual monthly spend
const expenseIdeas = (facts) => (facts.expense_accounts || [])
  .filter((row) => num(row.monthly_average) > 0 && num(row.recent) > EXPENSE_JUMP * num(row.monthly_average)
    && num(row.recent) - num(row.monthly_average) >= 50)
  .slice(0, 2)
  .map((row) => {
    const times = round2(num(row.recent) / num(row.monthly_average));
    return idea({
      dedupe_key: `expense:${row.id}:${String(facts.today).slice(0, 7)}`,
      category: 'operations',
      title: `Spending on ${row.name} jumped to ${times}x the usual`,
      summary: `In the last 30 days ${formatMoney(row.recent, facts.currency)} went to ${row.name}, against a monthly average of ${formatMoney(row.monthly_average, facts.currency)} over the 3 months before. Worth checking whether it was a one-off, a price rise or a mistake.`,
      evidence: [
        { fact: `${row.name}: last 30 days`, number: num(row.recent), source: 'Accounting ledger' },
        { fact: `${row.name}: monthly average, previous 3 months`, number: num(row.monthly_average), source: 'Accounting ledger' }
      ],
      pros: ['Catching cost creep early saves money every month.'],
      cons: ['It takes a little time to go through the entries.'],
      risks: ['It may be a timing difference (a bill paid early) rather than real extra spending.'],
      expected_impact: { metric: 'other', amount: round2(num(row.recent) - num(row.monthly_average)), currency: facts.currency, timeframe_days: 30, confidence: 0.3 },
      actions: []
    });
  });

const runRules = (facts, forecast) => {
  const findings = [];
  for (const rule of [overdueIdeas, stockIdeas, dealIdeas, chatIdeas, (f) => cashIdeas(f, forecast), concentrationIdeas, payrollIdeas, expenseIdeas]) {
    try {
      findings.push(...rule(facts));
    } catch (error) {
      console.error('Brain rule skipped:', rule.name, error?.message);
    }
  }
  return findings;
};

module.exports = { runRules, isoDay };
