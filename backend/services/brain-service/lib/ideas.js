// Checking ideas from the AI layer and from AI tools over MCP before they are saved. Anything that
// doesn't fit is dropped or corrected here; the database checks again.

const { checkActions } = require('./catalog');

const CATEGORIES = ['cash', 'sales', 'stock', 'people', 'marketing', 'operations', 'risk'];
const EFFORTS = ['S', 'M', 'L'];

// What can be measured later, and which way is better
const METRICS = {
  invoices_owed: { better: 'lower', needsIds: true, label: 'money still owed on those invoices' },
  items_short: { better: 'lower', needsIds: true, label: 'items still at or below their reorder level' },
  deals_quiet: { better: 'lower', needsIds: true, label: 'deals still quiet' },
  chats_waiting: { better: 'lower', needsIds: true, label: 'chats still waiting' },
  overdue_total: { better: 'lower', label: 'total overdue invoices' },
  cash_balance: { better: 'higher', label: 'cash in bank and cash accounts' },
  revenue_30d: { better: 'higher', label: 'revenue invoiced in the last 30 days' },
  new_leads_30d: { better: 'higher', label: 'new leads in the last 30 days' },
  won_value_30d: { better: 'higher', label: 'value of deals won in the last 30 days' },
  other: { better: null, label: 'not measured automatically' }
};
// Metrics an AI may pick (the id-based ones only come from the rules)
const AI_METRICS = ['overdue_total', 'cash_balance', 'revenue_30d', 'new_leads_30d', 'won_value_30d', 'other'];

const clean = (value, max) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const textList = (value, maxItems, maxLength) => (Array.isArray(value) ? value : [])
  .map((item) => clean(item, maxLength)).filter(Boolean).slice(0, maxItems);

const finite = (value) => (value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : NaN);

// Every number in the data the AI was shown, so evidence can only cite real ones
const numbersIn = (value, found = new Set()) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    found.add(Math.round(value * 100) / 100);
    found.add(Math.round(Math.abs(value) * 100) / 100);
    found.add(Math.round(value));
  } else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    numbersIn(Number(value), found);
  } else if (Array.isArray(value)) {
    value.forEach((item) => numbersIn(item, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => numbersIn(item, found));
  }
  return found;
};

const known = (numbers, n) => numbers.has(Math.round(n * 100) / 100) || numbers.has(Math.round(Math.abs(n) * 100) / 100) || numbers.has(Math.round(n));

// Returns { idea } or { error } (a plain reason). Options:
//   numbers: Set of numbers evidence may cite (AI layer); null accepts any number (MCP)
//   knownIds: Set of record ids actions may point at; null accepts any valid id
//   source, sourceKeyId: who proposed it
const checkIdea = (raw, { numbers = null, knownIds = null, source = 'brain', sourceKeyId = null } = {}) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'An idea must be an object' };
  const notes = [];
  const title = clean(raw.title, 200);
  if (title.length < 3) return { error: 'An idea needs a title' };
  const category = CATEGORIES.includes(raw.category) ? raw.category : null;
  if (!category) return { error: `Category must be one of ${CATEGORIES.join(', ')}` };
  const summary = clean(raw.summary, 2000);
  if (!summary) return { error: 'An idea needs a short summary' };

  const evidence = [];
  for (const item of (Array.isArray(raw.evidence) ? raw.evidence : []).slice(0, 8)) {
    const fact = clean(item?.fact, 300);
    const number = finite(item?.number);
    if (!fact || Number.isNaN(number)) continue;
    if (numbers && number !== null && !known(numbers, number)) {
      notes.push(`Dropped evidence “${fact.slice(0, 60)}”: its number isn’t in the company’s data`);
      continue;
    }
    evidence.push({ fact, number, source: clean(item?.source, 100) || null });
  }
  if (!evidence.length) return { error: 'An idea needs at least one piece of evidence from the company’s numbers' };

  const pros = textList(raw.pros, 6, 300);
  const cons = textList(raw.cons, 6, 300);
  const risks = textList(raw.risks, 6, 300);
  if (!cons.length) return { error: 'An idea needs at least one con' };
  if (!risks.length) return { error: 'An idea needs at least one risk' };

  const impact = raw.expected_impact && typeof raw.expected_impact === 'object' ? raw.expected_impact : {};
  const allowed = numbers ? AI_METRICS : Object.keys(METRICS).filter((key) => !METRICS[key].needsIds);
  const metric = allowed.includes(impact.metric) ? impact.metric : 'other';
  const impactAmount = finite(impact.amount);
  const confidence = finite(impact.confidence);
  const timeframe = finite(impact.timeframe_days);
  const expected = {
    metric,
    amount: Number.isNaN(impactAmount) || impactAmount === null ? null : Math.round(impactAmount * 100) / 100,
    currency: typeof impact.currency === 'string' && /^[A-Za-z]{3}$/.test(impact.currency) ? impact.currency.toUpperCase() : null,
    timeframe_days: Number.isNaN(timeframe) || timeframe === null ? 30 : Math.min(Math.max(Math.round(timeframe), 1), 180),
    confidence: Number.isNaN(confidence) || confidence === null ? 0.3 : Math.min(Math.max(confidence, 0), 1)
  };

  const { kept, dropped } = checkActions(raw.actions || [], { knownIds });
  dropped.forEach((reason) => notes.push(`Dropped an action: ${reason}`));

  return {
    idea: {
      title, category, summary, evidence, pros, cons, risks,
      expected_impact: expected,
      effort: EFFORTS.includes(raw.effort) ? raw.effort : 'M',
      actions: kept,
      source: clean(source, 120) || 'brain',
      source_key_id: sourceKeyId,
      // From the title, never from the caller, so an outside idea can't block one of the rules' ideas
      dedupe_key: `idea:${category}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 120)}`,
      check_spec: metric !== 'other' ? { kind: metric } : null
    },
    notes
  };
};

// Was it worth it? Compares the measured value with the one taken when the idea was carried out.
const verdictFor = (metric, baseline, value, expectedAmount) => {
  const rule = METRICS[metric];
  if (!rule || !rule.better || baseline === null || baseline === undefined || value === null || value === undefined) return null;
  const b = Number(baseline);
  const v = Number(value);
  if (rule.better === 'lower') {
    if (b <= 0) return v <= 0 ? 'worked' : 'didnt';
    const improved = (b - v) / b;
    if (v <= 0 || improved >= 0.8) return 'worked';
    if (improved > 0.1) return 'partly';
    return 'didnt';
  }
  const gain = v - b;
  const target = Number(expectedAmount) > 0 ? Number(expectedAmount) : Math.max(Math.abs(b) * 0.1, 1);
  if (gain >= target * 0.8) return 'worked';
  if (gain > 0) return 'partly';
  return 'didnt';
};

module.exports = { CATEGORIES, EFFORTS, METRICS, AI_METRICS, checkIdea, numbersIn, verdictFor, clean };
