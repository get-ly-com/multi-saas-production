import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import AppShell, { useAccount } from '@/components/AppShell';
import BrainTodayCard from '@/components/BrainTodayCard';
import { celebrate } from '@/components/Celebrate';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { money, today } from '@/lib/api';
import { cachedGet } from '@/lib/cache';
import { change, compactMoney, count, monthRange, plural } from '@/lib/format';
import { hideSetup, useSetup } from '@/lib/setup';
import { store } from '@/lib/ui';

export default function Today() {
  return <AppShell><TodayPage /></AppShell>;
}

// One API read for a tile. "hidden" means no access (403), so the tile isn't drawn at all.
type Source<T> = { data: T | null; state: 'loading' | 'ok' | 'hidden' | 'error' };

function useSource<T = any>(path: string | null): Source<T> {
  const [source, setSource] = useState<Source<T>>({ data: null, state: 'loading' });
  useEffect(() => {
    if (!path) return;
    let current = true;
    cachedGet(path)
      .then((data) => current && setSource({ data, state: 'ok' }))
      .catch((err) => current && setSource({ data: null, state: err?.status === 403 ? 'hidden' : 'error' }));
    return () => { current = false; };
  }, [path]);
  return source;
}

type Action = { id: string; kind: string; title: string; detail: string; link: string; link_label: string; priority: number };
type Feed = { actions: Action[]; note?: string; unavailable?: string[] };

// Honest guesses at how long each kind of job takes
const MINUTES: Record<string, number> = { overdue_invoice: 1, bank_match: 3, stock: 3, chat: 2, leave: 1, pay_run: 5, quiet_deal: 2 };
const KIND_ICONS: Record<string, string> = { overdue_invoice: 'invoice', bank_match: 'bank', stock: 'inventory', chat: 'chat', leave: 'leave', pay_run: 'money', quiet_deal: 'deal', setup: 'sparkle' };
const KIND_LABELS: Record<string, string> = { overdue_invoice: 'Money owed', bank_match: 'Banking', stock: 'Stock', chat: 'Chat', leave: 'Leave', pay_run: 'Payroll', quiet_deal: 'Deals', setup: 'Setup' };

const greetingFor = (hour: number) => (hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');

// "sam.jones@x.com" becomes "Sam". Anything that doesn't look like a name is left out.
const firstName = (email: string) => {
  const part = (email.split('@')[0] || '').split(/[._+-]/)[0];
  if (!part || part.length < 2 || /\d/.test(part) || ['info', 'admin', 'hello', 'contact', 'office', 'team', 'sales', 'accounts'].includes(part.toLowerCase())) return '';
  return part[0].toUpperCase() + part.slice(1).toLowerCase();
};

function TodayPage() {
  const account = useAccount();
  const tenant = account?.tenantId || '';
  const [from, to] = useMemo(() => monthRange(0), []);
  const day = today();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  const feed = useSource<Feed>('/api/analytics/assistant/actions');
  const dashboard = useSource<any>(`/api/analytics/dashboard?from=${from}&to=${to}`);
  const leads = useSource<any>('/api/crm/leads/summary');
  const quotes = useSource<any[]>('/api/crm/quotes');
  const invoices = useSource<any[]>('/api/accounting/invoices');
  const away = useSource<any[]>(`/api/hr/leave/out?from=${day}&to=${day}`);
  const setup = useSetup(tenant || undefined);

  const name = account ? firstName(account.me.user.email) : '';
  const dateLine = now ? now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : '';
  const greeting = now ? greetingFor(now.getHours()) : 'Hello';

  return (
    <div className="today">
      <header className="today-head">
        <p className="eyebrow">{dateLine || ' '}</p>
        <h1 className="greeting">{greeting}{name ? `, ${name}` : ''}</h1>
      </header>

      <WorkflowStrip leads={leads} dashboard={dashboard} quotes={quotes} invoices={invoices} from={from} />

      <div className="today-grid">
        <div className="today-main">
          <ToDo feed={feed} tenant={tenant} setup={setup} />
          <GettingStarted tenant={tenant} setup={setup} />
        </div>
        <aside className="today-side" aria-label="Business performance">
          <BrainTodayCard />
          <Performance dashboard={dashboard} away={away} />
        </aside>
      </div>
    </div>
  );
}

// Leads → Deals → Quotes → Invoices awaiting payment → Paid this month.
// The products are one flow, and this strip is where you see it.
function WorkflowStrip({ leads, dashboard, quotes, invoices, from }: {
  leads: Source<any>; dashboard: Source<any>; quotes: Source<any[]>; invoices: Source<any[]>; from: string;
}) {
  const day = today();
  const [lastFrom] = monthRange(-1);
  type Stage = { key: string; tone: string; title: string; href: string; source: Source<any>; value?: number; word: string; subs: string[] };

  const quoteRows = quotes.data || [];
  const invoiceRows = invoices.data || [];
  const awaiting = invoiceRows.filter((row) => row.status === 'sent' || row.status === 'partial');
  const owed = awaiting.reduce((sum, row) => sum + Number(row.base_amount ?? row.amount) - Number(row.base_settled ?? row.amount_paid ?? 0), 0);
  const paidIn = (start: string, end?: string) => invoiceRows.filter((row) => {
    const paid = String(row.paid_at || '').slice(0, 10);
    return row.status === 'paid' && paid >= start && (!end || paid < end);
  });
  const paidNow = paidIn(from);
  const paidBefore = paidIn(lastFrom, from);
  const pipeline = dashboard.data?.pipeline;
  const won = dashboard.data?.current;

  const stages: Stage[] = [
    {
      key: 'leads', tone: 'tone-1', title: 'Leads', href: '/saas/crm/leads', source: leads,
      value: Number(leads.data?.open || 0), word: 'open',
      subs: [`${count(leads.data?.new)} new`, `${count(leads.data?.unassigned)} unassigned`]
    },
    {
      key: 'deals', tone: 'tone-2', title: 'Deals', href: '/saas/crm/pipeline', source: dashboard,
      value: Number(pipeline?.open_deals || 0), word: 'in progress',
      subs: [`${compactMoney(pipeline?.value)} in pipeline`, `${count(won?.won_deals)} won this month`]
    },
    {
      key: 'quotes', tone: 'tone-3', title: 'Quotes', href: '/saas/crm/quotes', source: quotes,
      value: quoteRows.filter((row) => row.status === 'sent' && !(row.valid_until && row.valid_until < day)).length, word: 'waiting for a reply',
      subs: [
        plural(quoteRows.filter((row) => row.status === 'draft').length, 'draft'),
        `${count(quoteRows.filter((row) => row.status === 'accepted' && String(row.issue_date || '') >= from).length)} accepted this month`
      ]
    },
    {
      key: 'awaiting', tone: 'tone-4', title: 'Invoices', href: '/saas/accounting', source: invoices,
      value: awaiting.length, word: 'awaiting payment',
      subs: [compactMoney(owed), `${count(awaiting.filter((row) => row.due_date && row.due_date < day).length)} overdue`]
    },
    {
      key: 'paid', tone: 'tone-5', title: 'Paid', href: '/saas/accounting', source: invoices,
      value: paidNow.length, word: 'paid this month',
      subs: [compactMoney(paidNow.reduce((sum, row) => sum + Number(row.base_amount ?? row.amount), 0)), `${count(paidBefore.length)} last month`]
    }
  ];

  const shown = stages.filter(({ source }) => source.state !== 'hidden' && source.state !== 'error');
  if (!shown.length && stages.every(({ source }) => source.state !== 'loading')) return null;

  return (
    <section className="flow" aria-label="From lead to paid">
      <ol className="flow-track">
        {shown.map((stage, index) => (
          <li key={stage.key} className={`flow-step ${stage.tone}`}>
            <Link href={stage.href} className="flow-card">
              <span className="flow-title">{stage.title}</span>
              {stage.source.state === 'loading'
                ? <><Skeleton width={48} height={28} style={{ margin: '6px 0 4px' }} /><Skeleton width="80%" height={10} /></>
                : (
                  <>
                    <span className="flow-count">{count(stage.value)}</span>
                    <span className="flow-word">{stage.word}</span>
                    <span className="flow-subs">
                      {stage.subs.map((sub) => <span key={sub}>{sub}</span>)}
                    </span>
                  </>
                )}
            </Link>
            {index < shown.length - 1 && <Icon name="chevron-right" size={16} className="flow-arrow" />}
          </li>
        ))}
      </ol>
    </section>
  );
}

const doneKey = (tenant: string, day: string) => `getly:todo-done:${tenant}:${day}`;
const cheeredKey = (tenant: string, day: string) => `getly:caught-up:${tenant}:${day}`;

type Row = { id: string; kind: string; title: string; detail: string; link: string; linkLabel: string; minutes: number };

function ToDo({ feed, tenant, setup }: { feed: Source<Feed>; tenant: string; setup: ReturnType<typeof useSetup> }) {
  const day = today();
  const [done, setDone] = useState<string[]>([]);
  const [checking, setChecking] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const cheered = useRef(false);

  useEffect(() => {
    if (tenant) setDone(store.get<string[]>(doneKey(tenant, day), []));
  }, [tenant]);

  const save = (list: string[]) => {
    setDone(list);
    store.set(doneKey(tenant, day), list);
  };

  const nextStep = setup.steps.find((step) => !step.done);
  const rows: Row[] = [
    ...(feed.data?.actions || []).map((action) => ({
      id: action.id, kind: action.kind, title: action.title, detail: action.detail, link: action.link,
      linkLabel: action.link_label, minutes: MINUTES[action.kind] || 2
    })),
    ...(nextStep && !setup.hidden ? [{
      id: `setup:${nextStep.key}`, kind: 'setup', title: nextStep.title, detail: nextStep.line, link: nextStep.href,
      linkLabel: 'Start', minutes: nextStep.minutes
    }] : [])
  ];
  const open = rows.filter((row) => !done.includes(row.id));
  const ready = feed.state !== 'loading';
  const caughtUp = ready && feed.state === 'ok' && !feed.data?.note && open.length === 0;

  // A small celebration the first time each day that everything is clear
  useEffect(() => {
    if (!caughtUp || cheered.current || !tenant) return;
    cheered.current = true;
    if (!store.get(cheeredKey(tenant, day), false)) {
      store.set(cheeredKey(tenant, day), true);
      setTimeout(() => celebrate({ from: box.current?.querySelector('.empty-art') }), 250);
    }
  }, [caughtUp, tenant]);

  const check = (row: Row) => {
    setChecking((list) => [...list, row.id]);
    // Let the tick draw before the row folds away
    setTimeout(() => {
      setChecking((list) => list.filter((id) => id !== row.id));
      const next = [...store.get<string[]>(doneKey(tenant, day), []), row.id];
      save(next);
      toast.success('Done for today', {
        detail: 'It comes back tomorrow if it still needs you.',
        action: { label: 'Undo', onClick: () => save(store.get<string[]>(doneKey(tenant, day), []).filter((id) => id !== row.id)) }
      });
    }, 520);
  };

  if (feed.state === 'hidden') return null;

  return (
    <section className="card todo" ref={box} aria-labelledby="todo-title">
      <div className="section-head">
        <div>
          <h2 id="todo-title">To do</h2>
          <p className="muted">Things across your apps that need you, most urgent first.</p>
        </div>
        {ready && open.length > 0 && <span className="count-pill">{open.length}</span>}
      </div>

      {!ready && (
        <div className="todo-list" aria-busy="true">
          {[0, 1, 2].map((n) => (
            <div className="todo-row" key={n}>
              <Skeleton width={22} height={22} radius={999} />
              <div style={{ flex: 1, display: 'grid', gap: 6 }}><Skeleton width="55%" height={13} /><Skeleton width="80%" height={11} /></div>
            </div>
          ))}
        </div>
      )}

      {feed.state === 'error' && <p className="muted">We couldn&apos;t check for things to do just now. Try again in a minute.</p>}
      {feed.data?.note && <p className="muted">{feed.data.note}</p>}

      {ready && open.length > 0 && (
        <ul className="todo-list">
          {open.map((row) => {
            const ticking = checking.includes(row.id);
            return (
              <li key={row.id} className={`todo-row ${ticking ? 'is-checking' : ''}`}>
                <button type="button" className="todo-check always" aria-label={`Mark "${row.title}" as done for today`} onClick={() => check(row)} disabled={ticking}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M7.5 12.5l3 3 6-6.5" /></svg>
                </button>
                <span className="todo-icon" aria-hidden="true"><Icon name={KIND_ICONS[row.kind] || 'sparkle'} size={16} /></span>
                <Link href={row.link} className="todo-text">
                  <strong>{row.title}</strong>
                  <span>{row.detail}</span>
                </Link>
                <span className="todo-meta">
                  <span className="chip" title={KIND_LABELS[row.kind]}>{row.minutes === 1 ? '1 minute' : `${row.minutes} minutes`}</span>
                  <Link href={row.link} className="button ghost small todo-go">{row.linkLabel}<Icon name="arrow-right" size={14} /></Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {caughtUp && (
        <EmptyState
          tone="done"
          icon="inbox"
          compact
          title="You're all caught up"
          line="Nothing needs you right now. Time is yours again."
          action={{ label: 'Ask the assistant', href: '/saas/assistant' }}
        />
      )}

      {feed.data?.unavailable && feed.data.unavailable.length > 0 && (
        <p className="muted small">We couldn&apos;t check {feed.data.unavailable.join(', ')} just now.</p>
      )}
    </section>
  );
}

function Ring({ done, total }: { done: number; total: number }) {
  const r = 18;
  const length = 2 * Math.PI * r;
  const part = total ? done / total : 0;
  return (
    <svg className="ring" viewBox="0 0 44 44" role="img" aria-label={`${done} of ${total} done`}>
      <circle className="ring-track" cx="22" cy="22" r={r} />
      <circle className="ring-fill" cx="22" cy="22" r={r} strokeDasharray={length} strokeDashoffset={length * (1 - part)} />
      <text x="22" y="26" textAnchor="middle">{done}/{total}</text>
    </svg>
  );
}

function GettingStarted({ tenant, setup }: { tenant: string; setup: ReturnType<typeof useSetup> }) {
  if (!tenant || setup.hidden || setup.loading || !setup.total) return null;
  if (setup.finished && !setup.justFinished) return null;

  if (setup.complete) {
    return (
      <section className="card setup-card is-complete" id="setup">
        <EmptyState
          tone="done"
          icon="party"
          compact
          title="You're all set"
          line="Every app is ready to go. This list won't show again."
        />
      </section>
    );
  }

  return (
    <section className="card setup-card" id="setup" aria-labelledby="setup-title">
      <div className="section-head">
        <div className="setup-title">
          <Ring done={setup.done} total={setup.total} />
          <div>
            <h2 id="setup-title">Getting started</h2>
            <p className="muted">A few steps to get the most from Get-ly. Each one ticks itself when it&apos;s done.</p>
          </div>
        </div>
        <button type="button" className="ghost small always" onClick={() => hideSetup(tenant)}>Hide</button>
      </div>
      <ol className="steps">
        {setup.steps.map((step) => (
          <li key={step.key} className={`step ${step.done ? 'is-done' : ''}`}>
            <span className="step-mark" aria-hidden="true">{step.done ? <Icon name="check" size={14} strokeWidth={2.5} /> : null}</span>
            {step.done
              ? <span className="step-text"><strong>{step.title}</strong><span className="sr-only"> (done)</span></span>
              : (
                <Link href={step.href} className="step-text">
                  <strong>{step.title}</strong>
                  <span>{step.line}</span>
                </Link>
              )}
            {!step.done && <span className="chip">{step.minutes === 1 ? '1 minute' : `${step.minutes} minutes`}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Spark({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2 || values.every((value) => value === 0)) return null;
  const width = 96;
  const height = 32;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const x = (n: number) => (n / (values.length - 1)) * (width - 2) + 1;
  const y = (value: number) => height - 2 - ((value - min) / span) * (height - 6);
  const line = values.map((value, n) => `${n ? 'L' : 'M'}${x(n).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none">
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} />
      <circle className="spark-dot" cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2.5" />
    </svg>
  );
}

function PerfCard({ title, value, note, href, trend, delta, icon }: {
  title: string; value: string; note?: string; href: string; trend?: number[]; delta?: ReturnType<typeof change>; icon: string;
}) {
  return (
    <Link href={href} className="perf-card">
      <span className="perf-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>
      <span className="perf-body">
        <span className="perf-title">{title}</span>
        <span className="perf-value">{value}</span>
        {(delta || note) && (
          <span className="perf-note">
            {delta && !delta.flat && <span className={`delta ${delta.up ? 'is-up' : 'is-down'}`}>{delta.up ? '↑' : '↓'} {Math.abs(delta.percent)}%</span>}
            {delta && delta.flat && <span className="delta">No change</span>}
            {note && <span>{note}</span>}
          </span>
        )}
      </span>
      {trend && <Spark values={trend} label={`${title} over the last 12 months`} />}
      <Icon name="chevron-right" size={16} className="perf-chevron" />
    </Link>
  );
}

function Performance({ dashboard, away }: { dashboard: Source<any>; away: Source<any[]> }) {
  const data = dashboard.data;
  const trend = (key: string) => (data?.trend || []).map((row: any) => Number(row[key]) || 0);
  const out = away.data || [];

  return (
    <section className="perf" aria-labelledby="perf-title">
      <h2 id="perf-title" className="side-title">Business performance</h2>
      {dashboard.state === 'loading' && [0, 1, 2].map((n) => (
        <div className="perf-card is-skeleton" key={n}><Skeleton width={32} height={32} radius={8} /><span className="perf-body"><Skeleton width="50%" height={11} /><Skeleton width="70%" height={20} style={{ marginTop: 6 }} /></span></div>
      ))}
      {data && (
        <>
          <PerfCard
            title="Invoiced this month" icon="invoice" href="/saas/analytics"
            value={money(data.current.revenue, data.currency)}
            delta={change(data.current.revenue, data.previous.revenue)} note="vs last month"
            trend={trend('revenue')}
          />
          <PerfCard
            title="Money owed to you" icon="money" href="/saas/accounting/follow-ups"
            value={money(data.receivables.outstanding, data.currency)}
            note={Number(data.receivables.overdue_count) > 0
              ? `${money(data.receivables.overdue, data.currency)} overdue on ${plural(data.receivables.overdue_count, 'invoice')}`
              : 'Nothing overdue. Nice.'}
          />
          <PerfCard
            title="Open pipeline" icon="deal" href="/saas/crm/pipeline"
            value={money(data.pipeline.value, data.currency)}
            note={`${money(data.pipeline.weighted, data.currency)} likely to close`}
            trend={trend('won_value')}
          />
          {data.marketing?.upcoming && (
            <PerfCard
              title="Upcoming bookings" icon="scheduler" href="/saas/scheduler"
              value={count(data.marketing.upcoming.bookings)}
              note={`In the next 7 days · ${money(data.marketing.upcoming.value, data.currency)}`}
              trend={trend('bookings')}
            />
          )}
          <PerfCard
            title="Stock alerts" icon="inventory" href="/saas/inventory/reorder"
            value={count(data.stock.low)}
            note={Number(data.stock.low) ? 'Items low or out of stock' : 'All stocked up'}
          />
        </>
      )}
      {away.state === 'ok' && (
        <PerfCard
          title="People out today" icon="leave" href="/saas/hr/leave"
          value={count(new Set(out.map((row) => row.employee_id)).size)}
          note={out.length ? out.slice(0, 3).map((row) => row.name).join(', ') + (out.length > 3 ? ` and ${out.length - 3} more` : '') : 'Everyone is in'}
        />
      )}
      {dashboard.state === 'error' && <p className="muted small">We couldn&apos;t load your numbers just now.</p>}
    </section>
  );
}
