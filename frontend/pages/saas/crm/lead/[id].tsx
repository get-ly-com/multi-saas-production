import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { useTeam } from '@/components/CrmForms';
import { CustomValues } from '@/components/CustomFields';
import { ConvertForm, DisqualifyForm, LeadForm, scoreBadge, scoreLabel, statusBadge, statusLabel } from '@/components/LeadForms';
import Timeline from '@/components/Timeline';
import { api, formatDate } from '@/lib/api';

export default function Lead() {
  return <AppShell><LeadApp /></AppShell>;
}

function LeadApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const members = useTeam();
  const [lead, setLead] = useState<any>(null);
  const [matches, setMatches] = useState<any>({ contacts: [], leads: [] });
  const [error, setError] = useState('');
  const [form, setForm] = useState('');

  const load = async () => {
    try {
      const [row, found] = await Promise.all([api.get(`/api/crm/leads/${id}`), api.get(`/api/crm/leads/${id}/matches`)]);
      setLead(row);
      setMatches(found);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (id) load();
  }, [id]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const setStatus = (status: string) => run(() => api.put(`/api/crm/leads/${id}`, { status }));

  const remove = async () => {
    if (!window.confirm(`Delete ${lead.name}? This can't be undone.`)) return;
    try {
      await api.delete(`/api/crm/leads/${id}`);
      router.push('/saas/crm/leads');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const merge = (other: any) => {
    if (window.confirm(`Merge ${other.name} into ${lead.name}? ${other.name} is removed and its timeline moves here.`)) {
      run(() => api.post(`/api/crm/leads/${id}/merge`, { drop_id: other.id }));
    }
  };

  const owner = members.find(({ user_id }) => user_id === lead?.owner_id)?.email;
  const open = lead && ['new', 'working'].includes(lead.status);

  return (
    <div className="stack">
      <CrmNav />
      {error && <p className="error">{error}</p>}
      {lead && (
        <>
          <div className="page-head">
            <div>
              <h1>{lead.name} <span className={`badge ${statusBadge[lead.status]}`}>{statusLabel[lead.status]}</span></h1>
              <p className="muted">{[lead.job_title, lead.company_name, lead.email, lead.phone, lead.source, owner].filter(Boolean).join(' · ')}</p>
              {lead.campaign && <p className="muted">Campaign: {lead.campaign}</p>}
            </div>
            <div className="row-actions">
              {open && <button className="primary" onClick={() => setForm('convert')}>Convert</button>}
              {lead.status === 'new' && <button onClick={() => setStatus('working')}>Start working</button>}
              {open && <button onClick={() => setForm('disqualify')}>Disqualify</button>}
              {lead.status === 'disqualified' && <button onClick={() => setStatus('working')}>Reopen</button>}
              {lead.status !== 'converted' && <button onClick={() => setForm('edit')}>Edit</button>}
              <button className="danger" onClick={remove}>Delete</button>
            </div>
          </div>

          {lead.status === 'converted' && (
            <div className="card">
              <p>
                Converted on {formatDate(lead.converted_at)}.
                {lead.converted_contact_id && <> <Link href={`/saas/crm/contact/${lead.converted_contact_id}`}>Open the contact</Link>.</>}
                {lead.converted_deal_id && <> <Link href={`/saas/crm/deal/${lead.converted_deal_id}`}>Open the deal</Link>.</>}
              </p>
            </div>
          )}
          {lead.disqualified_reason && <p className="muted">Disqualified because: {lead.disqualified_reason}</p>}

          <div className="card">
            <h2>Score {lead.score} <span className={`badge ${scoreBadge(lead.score)}`}>{scoreLabel(lead.score)}</span></h2>
            {lead.score_reasons.length === 0 && <p className="muted">No scoring rules match yet.</p>}
            {lead.score_reasons.map((reason: any) => (
              <div className="score-line" key={reason.label}><span>{reason.label}</span><span>{reason.points > 0 ? '+' : ''}{reason.points}</span></div>
            ))}
          </div>

          {open && matches.contacts.length + matches.leads.length > 0 && (
            <div className="card table-wrap">
              <h2>Possible duplicates</h2>
              <table>
                <tbody>
                  {matches.contacts.map((contact: any) => (
                    <tr key={contact.id}>
                      <td className="wrap"><Link href={`/saas/crm/contact/${contact.id}`}>{contact.name}</Link></td>
                      <td>{contact.email || contact.phone || '—'}</td>
                      <td>Contact</td>
                      <td />
                    </tr>
                  ))}
                  {matches.leads.map((other: any) => (
                    <tr key={other.id}>
                      <td className="wrap"><Link href={`/saas/crm/lead/${other.id}`}>{other.name}</Link></td>
                      <td>{other.email || other.phone || '—'}</td>
                      <td>Lead</td>
                      <td><div className="row-actions"><button onClick={() => merge(other)}>Merge in</button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {lead.notes && <div className="card wrap">{lead.notes}</div>}
          <CustomValues entity="lead" values={lead.custom} />
          {lead.status !== 'converted' && <Timeline links={{ lead_id: lead.id }} onChange={load} />}

          {form === 'edit' && <LeadForm initial={lead} onClose={() => setForm('')} onSaved={load} />}
          {form === 'disqualify' && <DisqualifyForm lead={lead} onClose={() => setForm('')} onSaved={load} />}
          {form === 'convert' && <ConvertForm lead={lead} matches={matches.contacts} onClose={() => setForm('')} />}
        </>
      )}
    </div>
  );
}
