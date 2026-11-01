import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { DealForm, LostForm, useTeam } from '@/components/CrmForms';
import Timeline from '@/components/Timeline';
import { api, formatDate, money } from '@/lib/api';

export default function Deal() {
  return <AppShell><DealApp /></AppShell>;
}

function DealApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const members = useTeam();
  const [deal, setDeal] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [losing, setLosing] = useState('');

  const load = async () => {
    try {
      const [row, historyRows, pipelineRows] = await Promise.all([
        api.get(`/api/crm/deals/${id}`),
        api.get(`/api/crm/deals/${id}/history`),
        api.get('/api/crm/pipelines')
      ]);
      setDeal(row);
      setHistory(historyRows);
      setPipelines(pipelineRows);
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

  const move = async (stage: any) => {
    if (stage.id === deal.stage_id) return;
    if (stage.kind === 'lost') return setLosing(stage.id);
    try {
      await api.put(`/api/crm/deals/${id}`, { stage_id: stage.id });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${deal.title}? This can't be undone.`)) return;
    try {
      await api.delete(`/api/crm/deals/${id}`);
      router.push('/saas/crm/pipeline');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const owner = members.find(({ user_id }) => user_id === deal?.owner_id)?.email;
  const moves = history.filter((row) => row.from_stage_id).map((row) => ({
    id: row.id,
    at: row.changed_at,
    content: <div className="timeline-item"><div><span className="badge">stage</span> {row.from_stage?.name} → {row.to_stage?.name}<div className="muted">{formatDate(row.changed_at)}</div></div></div>
  }));

  return (
    <div className="stack">
      <CrmNav />
      {error && <p className="error">{error}</p>}
      {deal && (
        <>
          <div className="page-head">
            <div>
              <h1>{deal.title}</h1>
              <p className="muted">
                {money(deal.value)}
                {deal.contact && <> · <Link href={`/saas/crm/contact/${deal.contact.id}`}>{deal.contact.name}</Link></>}
                {deal.company && <> · <Link href={`/saas/crm/company/${deal.company.id}`}>{deal.company.name}</Link></>}
                {deal.expected_close && ` · closes ${formatDate(deal.expected_close)}`}
                {owner && ` · ${owner}`}
              </p>
            </div>
            <div className="row-actions">
              <button onClick={() => setEditing(true)}>Edit</button>
              <button className="danger" onClick={remove}>Delete</button>
            </div>
          </div>

          <div className="stage-bar">
            {stages.map((stage: any) => (
              <button key={stage.id} className={stage.id === deal.stage_id ? 'primary' : ''} onClick={() => move(stage)}>{stage.name}</button>
            ))}
          </div>
          {deal.lost_reason && <p className="muted">Lost because: {deal.lost_reason}</p>}

          <Timeline links={{ deal_id: deal.id }} extra={moves} />

          {editing && <DealForm initial={{ ...deal, value: deal.value ?? '' }} onClose={() => setEditing(false)} onSaved={load} />}
          {losing && <LostForm deal={deal} stageId={losing} onClose={() => setLosing('')} onSaved={load} />}
        </>
      )}
    </div>
  );
}
