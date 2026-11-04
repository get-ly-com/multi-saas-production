import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import Icon from '@/components/Icon';
import CrmNav from '@/components/CrmNav';
import { TagChips, useTags } from '@/components/Tags';
import { DealForm, LostForm, useTeam } from '@/components/CrmForms';
import { CustomValues } from '@/components/CustomFields';
import { celebrate } from '@/components/Celebrate';
import { RecordHeader, RecordSkeleton } from '@/components/CrmRecord';
import { toast } from '@/components/Toast';
import QuoteForm from '@/components/QuoteForm';
import Timeline from '@/components/Timeline';
import { api, formatDate, money, queryId } from '@/lib/api';
import { automaticCategory, categoryName } from '@/lib/forecast';
import { quoteBadge, quoteLabel } from '../quotes';
import useSubmit from '@/lib/useSubmit';
import styles from '@/styles/crm.module.css';

export default function Deal() {
  return <AppShell><DealApp /></AppShell>;
}

function DealApp() {
  const router = useRouter();
  const id = queryId(router.query.id);
  const members = useTeam();
  const [deal, setDeal] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [quotes, setQuotes] = useState<any[]>([]);
  const [profit, setProfit] = useState<any>(null);
  const [error, setError] = useState('');
  const tags = useTags();
  const [editing, setEditing] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [losing, setLosing] = useState('');
  const stepper = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const [row, historyRows, pipelineRows, quoteRows, profitRow] = await Promise.all([
        api.get(`/api/crm/deals/${id}`),
        api.get(`/api/crm/deals/${id}/history`),
        api.get('/api/crm/pipelines'),
        api.get(`/api/crm/quotes?deal_id=${id}`),
        api.get(`/api/crm/deals/${id}/profit`).catch(() => null)
      ]);
      setProfit(profitRow);
      setDeal(row);
      setHistory(historyRows);
      setPipelines(pipelineRows);
      setQuotes(quoteRows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (id) load();
  }, [id]);

  const stages = useMemo(() => {
    const pipeline = pipelines.find((row) => row.id === deal?.stage?.pipeline_id);
    return pipeline ? [...pipeline.stages].sort((a: any, b: any) => a.position - b.position) : [];
  }, [pipelines, deal]);

  const { busy, run: once } = useSubmit();
  const move = (stage: any) => once(async () => {
    if (stage.id === deal.stage_id) return;
    if (stage.kind === 'lost') return setLosing(stage.id);
    const before = deal.stage;
    try {
      await api.put(`/api/crm/deals/${id}`, { stage_id: stage.id });
      const undo = before && before.kind !== 'lost' ? {
        label: 'Undo',
        onClick: () => api.put(`/api/crm/deals/${id}`, { stage_id: before.id }).then(load).catch((err) => toast.error('Could not undo', { detail: err.message }))
      } : undefined;
      if (stage.kind === 'won' && before?.kind !== 'won') {
        celebrate({ from: stepper.current?.querySelector(`[data-stage="${stage.id}"]`) });
        toast.success('Deal won', { detail: `${deal.title}, ${money(deal.value)}. Lovely work.`, action: undo });
      } else {
        toast.info(`Moved to ${stage.name}`, { action: undo });
      }
      await load();
    } catch (err: any) {
      toast.error('Could not move the deal', { detail: err.message });
    }
  });

  const remove = () => once(async () => {
    if (!window.confirm(`Delete ${deal.title}? This can't be undone.`)) return;
    try {
      await api.delete(`/api/crm/deals/${id}`);
      toast.success('Deal deleted', { detail: deal.title });
      router.push('/saas/crm/pipeline');
    } catch (err: any) {
      setError(err.message);
    }
  });

  const owner = members.find(({ user_id }) => user_id === deal?.owner_id)?.email;
  const moves = history.filter((row) => row.from_stage_id).map((row) => ({
    id: row.id,
    at: row.changed_at,
    icon: 'stage',
    tone: (row.to_stage?.kind === 'won' ? 'toneGood' : row.to_stage?.kind === 'lost' ? 'toneDanger' : 'toneWarn') as 'toneGood' | 'toneDanger' | 'toneWarn',
    content: <><strong>Moved to {row.to_stage?.name}</strong><span className="muted">from {row.from_stage?.name}</span></>
  }));
  // A row with no stage is a new expected close date
  const dateMoves = history.filter((row) => !row.to_stage_id && row.from_close !== row.to_close).map((row) => ({
    id: row.id,
    at: row.changed_at,
    icon: 'calendar',
    tone: 'toneAccent' as const,
    content: <><strong>Close date now {row.to_close ? formatDate(row.to_close) : 'not set'}</strong><span className="muted">was {row.from_close ? formatDate(row.from_close) : 'not set'}</span></>
  }));
  // From the deal's invoices, after the cost of the stock they took
  const revenue = Number(profit?.revenue || 0);
  const earned = Number(profit?.invoices) > 0 && revenue
    ? `profit ${money(revenue - Number(profit.cost))} (${Math.round(((revenue - Number(profit.cost)) / revenue) * 100)}%) on ${money(revenue)} invoiced`
    : '';
  const forecast = deal?.stage?.kind === 'open'
    ? `${categoryName(deal.forecast_category || automaticCategory(deal.stage.probability))}${deal.forecast_category ? '' : ' (from the stage)'}`
    : '';

  return (
    <div className="stack">
      <CrmNav />
      {error && <p className="error">{error}</p>}
      {!deal && !error && <RecordSkeleton />}
      {deal && (
        <>
          <RecordHeader
            name={deal.title}
            square
            badge={deal.stage && <span className={`badge ${deal.stage.kind}`}>{deal.stage.name}</span>}
            chips={[
              { icon: 'money', label: money(deal.value), title: 'Value' },
              deal.contact && { icon: 'contact', label: deal.contact.name, href: `/saas/crm/contact/${deal.contact.id}` },
              deal.company && { icon: 'company', label: deal.company.name, href: `/saas/crm/company/${deal.company.id}` },
              deal.expected_close && { icon: 'calendar', label: `Closes ${formatDate(deal.expected_close)}` },
              owner && { icon: 'user', label: owner, title: 'Owner' },
              deal.source && { icon: 'globe', label: deal.source, title: 'Source' },
              forecast && { icon: 'target', label: `Forecast: ${forecast}` },
              earned && { icon: 'paid', label: earned[0].toUpperCase() + earned.slice(1) }
            ]}
            tags={deal.tags?.length ? <TagChips ids={deal.tags} tags={tags} /> : null}
            actions={(
              <>
                <button onClick={() => setEditing(true)}>Edit</button>
                <button disabled={busy} className="danger ghost" onClick={remove}>Delete</button>
                <button className="primary" onClick={() => setQuoting(true)}>New quote</button>
              </>
            )}
          />

          <div className={styles.stepper} ref={stepper} role="group" aria-label="Stage">
            {stages.map((stage: any, index: number) => {
              const at = stages.findIndex((row: any) => row.id === deal.stage_id);
              const current = stage.id === deal.stage_id;
              const passed = deal.stage?.kind === 'open' && index < at;
              return (
                <button disabled={busy} key={stage.id} data-stage={stage.id} aria-pressed={current} title={`Move to ${stage.name}`}
                  className={`${styles.step} ${current ? styles.current : passed ? styles.passed : ''} ${current && stage.kind === 'won' ? styles.wonStep : ''} ${current && stage.kind === 'lost' ? styles.lostStep : ''}`}
                  onClick={() => move(stage)}>
                  {passed && <Icon name="check" size={14} />}{stage.name}
                </button>
              );
            })}
          </div>
          {deal.lost_reason && <p className="notice">Lost because: {deal.lost_reason}</p>}
          <CustomValues entity="deal" values={deal.custom} />

          {quotes.length > 0 && (
            <div className="card table-wrap">
              <div className={styles.cardHead}><h2>Quotes</h2></div>
              <table>
                <tbody>
                  {quotes.map((quote) => (
                    <tr key={quote.id}>
                      <td><Link href={`/saas/crm/quote/${quote.id}`}>{quote.quote_number}</Link></td>
                      <td><span className={`badge ${quoteBadge(quoteLabel(quote))}`}>{quoteLabel(quote)}</span></td>
                      <td className="num">{money(quote.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Timeline key={quotes.length} links={{ deal_id: deal.id }} extra={[...moves, ...dateMoves]} />

          {editing && <DealForm initial={{ ...deal, value: deal.value ?? '' }} onClose={() => setEditing(false)} onSaved={async () => { toast.success('Saved'); await load(); }} />}
          {losing && <LostForm deal={deal} stageId={losing} onClose={() => setLosing('')} onSaved={async () => { toast.info('Marked as lost', { detail: 'Thanks for noting why. It makes the reports more useful.' }); await load(); }} />}
          {quoting && <QuoteForm initial={{ deal_id: deal.id }} onClose={() => setQuoting(false)} onSaved={(quoteId) => { router.push(`/saas/crm/quote/${quoteId}`); }} />}
        </>
      )}
    </div>
  );
}
