import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { TagChips, useTags } from '@/components/Tags';
import { DealForm, LostForm, useTeam } from '@/components/CrmForms';
import { CustomValues } from '@/components/CustomFields';
import QuoteForm from '@/components/QuoteForm';
import Timeline from '@/components/Timeline';
import { api, formatDate, money, queryId } from '@/lib/api';
import { automaticCategory, categoryName } from '@/lib/forecast';
import { quoteBadge, quoteLabel } from '../quotes';
import useSubmit from '@/lib/useSubmit';

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
    try {
      await api.put(`/api/crm/deals/${id}`, { stage_id: stage.id });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  const remove = () => once(async () => {
    if (!window.confirm(`Delete ${deal.title}? This can't be undone.`)) return;
    try {
      await api.delete(`/api/crm/deals/${id}`);
      router.push('/saas/crm/pipeline');
    } catch (err: any) {
      setError(err.message);
    }
  });

  const owner = members.find(({ user_id }) => user_id === deal?.owner_id)?.email;
  const moves = history.filter((row) => row.from_stage_id).map((row) => ({
    id: row.id,
    at: row.changed_at,
    content: <div className="timeline-item"><div><span className="badge">stage</span> {row.from_stage?.name} → {row.to_stage?.name}<div className="muted">{formatDate(row.changed_at)}</div></div></div>
  }));
  // A row with no stage is a new expected close date
  const dateMoves = history.filter((row) => !row.to_stage_id && row.from_close !== row.to_close).map((row) => ({
    id: row.id,
    at: row.changed_at,
    content: <div className="timeline-item"><div><span className="badge">close date</span> {formatDate(row.from_close)} → {formatDate(row.to_close)}<div className="muted">{formatDate(row.changed_at)}</div></div></div>
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
      {deal && (
        <>
          <div className="page-head">
            <div>
              <h1>{deal.title}</h1>
              <TagChips ids={deal.tags} tags={tags} />
              <p className="muted">
                {money(deal.value)}
                {deal.contact && <> · <Link href={`/saas/crm/contact/${deal.contact.id}`}>{deal.contact.name}</Link></>}
                {deal.company && <> · <Link href={`/saas/crm/company/${deal.company.id}`}>{deal.company.name}</Link></>}
                {deal.expected_close && ` · closes ${formatDate(deal.expected_close)}`}
                {owner && ` · ${owner}`}
                {deal.source && ` · ${deal.source}`}
                {forecast && ` · forecast: ${forecast}`}
                {earned && ` · ${earned}`}
              </p>
            </div>
            <div className="row-actions">
              <button onClick={() => setQuoting(true)}>New quote</button>
              <button onClick={() => setEditing(true)}>Edit</button>
              <button disabled={busy} className="danger" onClick={remove}>Delete</button>
            </div>
          </div>

          <div className="stage-bar">
            {stages.map((stage: any) => (
              <button disabled={busy} key={stage.id} className={stage.id === deal.stage_id ? 'primary' : ''} onClick={() => move(stage)}>{stage.name}</button>
            ))}
          </div>
          {deal.lost_reason && <p className="muted">Lost because: {deal.lost_reason}</p>}
          <CustomValues entity="deal" values={deal.custom} />

          {quotes.length > 0 && (
            <div className="card table-wrap">
              <h2>Quotes</h2>
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

          {editing && <DealForm initial={{ ...deal, value: deal.value ?? '' }} onClose={() => setEditing(false)} onSaved={load} />}
          {losing && <LostForm deal={deal} stageId={losing} onClose={() => setLosing('')} onSaved={load} />}
          {quoting && <QuoteForm initial={{ deal_id: deal.id }} onClose={() => setQuoting(false)} onSaved={(quoteId) => { router.push(`/saas/crm/quote/${quoteId}`); }} />}
        </>
      )}
    </div>
  );
}
