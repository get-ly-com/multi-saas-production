// Deterministic maths on the company's real numbers: the cash forecast, what-if scenarios and the
// to do list. No AI here, so the answers are the same every time for the same data.

const {
  isoDay, addDays, daysBetween, round2, num, formatMoney,
  overdueItems, bankMatchItems, runningOutItems, chatItems, leaveItems, payRunItems, quietDealItems, rankActions
} = require('./business');

// Overdue invoices are assumed to come in a week from today
const OVERDUE_COLLECT_DAYS = 7;

const owedOf = (row) => round2((num(row.amount) - num(row.amount_paid) - num(row.amount_credited)) * num(row.exchange_rate || 1));

const monthsAhead = (day, months) => {
  const date = new Date(`${day}T00:00:00Z`);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return isoDay(target);
};

// A day-by-day cash forecast for the next `days` days (30, 60 or 90) from what is owed both ways,
// recurring invoices and recent payroll. Every assumption is listed in plain words.
const forecastCash = (facts, days = 90) => {
  const horizon = [30, 60, 90].includes(Number(days)) ? Number(days) : 90;
  const today = facts.today || isoDay(new Date());
  const end = addDays(today, horizon);
  const currency = facts.currency || 'USD';
  const flows = [];
  const add = (day, change, kind) => {
    const when = day < today ? today : day;
    if (when <= end && change) flows.push({ day: when, change: round2(change), kind });
  };

  let overdueIn = 0;
  for (const invoice of facts.open_invoices || []) {
    const owed = owedOf(invoice);
    if (owed <= 0) continue;
    if (invoice.due_date && invoice.due_date < today) {
      overdueIn += owed;
      add(addDays(today, OVERDUE_COLLECT_DAYS), owed, 'in');
    } else {
      add(invoice.due_date || addDays(today, 30), owed, 'in');
    }
  }
  for (const bill of facts.open_bills || []) {
    const owed = round2((num(bill.amount) - num(bill.amount_paid)) * num(bill.exchange_rate || 1));
    if (owed > 0) add(bill.due_date || today, -owed, 'out');
  }
  let recurringCount = 0;
  for (const plan of facts.recurring || []) {
    const step = plan.frequency === 'monthly' ? 1 : plan.frequency === 'quarterly' ? 3 : 12;
    const amount = num(plan.amount);
    if (amount <= 0) continue;
    for (let run = num(plan.runs_done); run < num(plan.runs_done) + 40; run += 1) {
      const runDay = monthsAhead(plan.start_date, run * step);
      if (runDay > end || (plan.end_date && runDay > plan.end_date)) break;
      if (runDay < today) continue;
      add(addDays(runDay, num(plan.due_days)), amount, 'in');
      recurringCount += 1;
    }
  }
  const payroll = num(facts.monthly_payroll);
  if (payroll > 0) {
    for (let month = 0; month <= Math.ceil(horizon / 30); month += 1) {
      const first = monthsAhead(`${today.slice(0, 7)}-01`, month + 1);
      add(addDays(first, -1), -payroll, 'out');
    }
  }

  flows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const opening = num(facts.cash_balance);
  let balance = opening;
  let lowest = { date: today, balance: opening };
  let firstBelowZero = opening < 0 ? today : null;
  const byDay = new Map();
  for (const flow of flows) {
    balance = round2(balance + flow.change);
    byDay.set(flow.day, balance);
    if (balance < lowest.balance) lowest = { date: flow.day, balance };
    if (balance < 0 && !firstBelowZero) firstBelowZero = flow.day;
  }
  const balanceOn = (day) => {
    let value = opening;
    for (const flow of flows) if (flow.day <= day) value = round2(value + flow.change);
    return value;
  };
  const sum = (kind, until) => round2(flows.filter((f) => f.kind === kind && f.day <= until).reduce((total, f) => total + Math.abs(f.change), 0));

  const points = [30, 60, 90].filter((d) => d <= horizon).map((d) => {
    const day = addDays(today, d);
    return { days: d, date: day, balance: balanceOn(day), money_in: sum('in', day), money_out: sum('out', day) };
  });

  const thin = [];
  if (!opening && !(facts.open_invoices || []).length && !(facts.open_bills || []).length) {
    thin.push('There is very little money data yet (no bank balance, invoices or bills), so this forecast says little.');
  } else if (!opening) {
    thin.push('No bank or cash balance is recorded in Accounting, so the forecast starts from zero.');
  }

  const assumptions = [
    `Starts from ${formatMoney(opening, currency)} in bank and cash accounts today (${today}).`,
    'Open invoices are paid on their due date and open bills are paid on theirs.',
    overdueIn > 0 ? `Overdue invoices (${formatMoney(overdueIn, currency)}) are assumed to be paid within ${OVERDUE_COLLECT_DAYS} days. If they aren’t, cash will be lower.` : null,
    recurringCount ? `${recurringCount} recurring invoice${recurringCount === 1 ? '' : 's'} will be raised on schedule and paid on time.` : null,
    payroll > 0 ? 'Payroll is assumed to stay at its average of the last 3 months, paid at each month end.' : null,
    'Other spending that isn’t a bill yet (card spend, new costs) is not included.'
  ].filter(Boolean);

  return {
    currency,
    today,
    days: horizon,
    opening_balance: opening,
    points,
    lowest_point: lowest,
    first_below_zero: firstBelowZero,
    warning: firstBelowZero
      ? `Cash is projected to drop below zero around ${firstBelowZero}, reaching ${formatMoney(lowest.balance, currency)} on ${lowest.date}.`
      : null,
    assumptions,
    data_notes: thin
  };
};

// The average of the last 3 complete months from the dashboard trend
const recentMonths = (snapshot) => {
  const thisMonth = (snapshot?.today || isoDay(new Date())).slice(0, 7);
  const months = (snapshot?.last_12_months || []).filter((m) => String(m.month).slice(0, 7) < thisMonth).slice(-3);
  if (!months.length) return null;
  const avg = (key) => round2(months.reduce((t, m) => t + num(m[key]), 0) / months.length);
  return { count: months.length, revenue: avg('revenue'), profit: avg('profit'), cash_in: avg('cash_in'), cash_out: avg('cash_out') };
};

const LIMITS = {
  price_change_pct: [-50, 100],
  volume_change_pct: [-90, 200],
  expense_change_pct: [-90, 200],
  new_hire_monthly_cost: [0, 10000000],
  collect_overdue_pct: [0, 100],
  months: [1, 24]
};

// What-if maths on real numbers. Every input is optional.
const simulateScenario = (snapshot, facts, input = {}) => {
  const p = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw Object.assign(new Error(`${key} must be a number from ${min} to ${max}`), { status: 400 });
    }
    p[key] = n;
  }
  const months = Math.round(p.months || 3);
  const currency = snapshot?.currency || facts?.currency || 'USD';
  const base = recentMonths(snapshot);
  const notes = [];
  if (!base) notes.push('There are no complete months of revenue and profit yet, so the monthly figures start from zero.');
  else if (base.count < 3) notes.push(`Only ${base.count} complete month${base.count === 1 ? '' : 's'} of data, so the averages are rough.`);

  const revenue = base?.revenue || 0;
  const profit = base?.profit || 0;
  const costs = round2(revenue - profit);
  const price = (p.price_change_pct || 0) / 100;
  const volume = (p.volume_change_pct || 0) / 100;
  const spend = (p.expense_change_pct || 0) / 100;
  const hire = p.new_hire_monthly_cost || 0;

  const newRevenue = round2(revenue * (1 + price) * (1 + volume));
  const newCosts = round2(costs * (1 + spend) + hire);
  const newProfit = round2(newRevenue - newCosts);

  const cashNow = num(facts?.cash_balance);
  const overdue = round2((facts?.overdue_invoices || []).reduce((t, row) => t + Math.max(owedOf(row), 0), 0));
  const collected = round2(overdue * (p.collect_overdue_pct || 0) / 100);

  const money = (v) => formatMoney(v, currency);
  const assumptions = [
    base ? `Starting point: the average of the last ${base.count} complete month${base.count === 1 ? '' : 's'}: revenue ${money(revenue)}, costs ${money(costs)}, profit ${money(profit)} a month.` : null,
    p.price_change_pct ? `Prices change by ${p.price_change_pct}% and customers buy the same amount${p.volume_change_pct ? ` apart from the ${p.volume_change_pct}% change in volume` : ''}. In practice some customers may buy less after a price rise.` : null,
    !p.price_change_pct && p.volume_change_pct ? `Sales volume changes by ${p.volume_change_pct}% at today’s prices.` : null,
    p.expense_change_pct ? `All costs change by ${p.expense_change_pct}%.` : null,
    hire ? `A new hire adds ${money(hire)} a month in costs and brings in no extra revenue in this period.` : null,
    p.collect_overdue_pct ? `${p.collect_overdue_pct}% of the ${money(overdue)} overdue is collected once, straight away.` : null,
    'Monthly profit is used as a stand-in for monthly cash flow (timing of payments is ignored).',
    `Cash starts from ${money(cashNow)} in bank and cash accounts.`
  ].filter(Boolean);

  return {
    currency,
    months,
    inputs: p,
    baseline: { monthly_revenue: revenue, monthly_costs: costs, monthly_profit: profit },
    scenario: { monthly_revenue: newRevenue, monthly_costs: newCosts, monthly_profit: newProfit },
    change: { monthly_profit: round2(newProfit - profit), monthly_revenue: round2(newRevenue - revenue), monthly_costs: round2(newCosts - costs) },
    cash: {
      now: cashNow,
      one_off_collected: collected,
      projected_without_change: round2(cashNow + profit * months),
      projected_with_change: round2(cashNow + collected + newProfit * months),
      after_months: months
    },
    assumptions,
    data_notes: notes
  };
};

// The to do list from the Brain's facts, exactly as the analytics assistant shapes it. It is the
// company-wide view: chats waiting for anyone, every pending leave request.
const todoFromFacts = (facts) => {
  const today = facts.today || isoDay(new Date());
  const parts = [
    ['overdue_invoice', () => overdueItems(facts.overdue_invoices || [], today)],
    ['bank_match', () => bankMatchItems(facts.bank_lines || [], facts.open_invoices || [], facts.open_bills || [])],
    ['stock', () => runningOutItems(facts.items || [], facts.moves || [])],
    ['chat', () => chatItems(facts.waiting_chats || [])],
    ['leave', () => leaveItems(facts.leave || [], null, today)],
    ['pay_run', () => payRunItems(facts.draft_pay_runs || [])],
    ['quiet_deal', () => quietDealItems(facts.quiet_deals || [], today, facts.currency)]
  ];
  const results = parts.map(([kind, load]) => {
    try {
      return { kind, list: load() };
    } catch (error) {
      console.error(`Brain to do ${kind} skipped:`, error?.message);
      return { kind, list: [], failed: true };
    }
  });
  return { results, ...rankActions(results, { currency: facts.currency }) };
};

module.exports = { forecastCash, simulateScenario, todoFromFacts, owedOf, recentMonths, daysBetween };
