import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { TagChips, useTags } from '@/components/Tags';
import { useTeam } from '@/components/CrmForms';
import { CustomValues } from '@/components/CustomFields';
import { Bars, CrmIcon, RecordHeader, RecordSkeleton } from '@/components/CrmRecord';
import { toast } from '@/components/Toast';
import { ConvertForm, DisqualifyForm, LeadForm, scoreBadge, scoreLabel, statusBadge, statusLabel } from '@/components/LeadForms';
import Timeline from '@/components/Timeline';
import { api, formatDate, queryId } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import { whatsappLink, whatsappNumber } from '@/lib/whatsapp';
import styles from '@/styles/crm.module.css';

export default function Lead() {
  return <AppShell><LeadApp /></AppShell>;
}

function LeadApp() {
  const router = useRouter();
  const id = queryId(router.query.id);
  const members = useTeam();
  const [lead, setLead] = useState<any>(null);
  const [matches, setMatches] = useState<any>({ contacts: [], leads: [] });
  const [error, setError] = useState('');
  const tags = useTags();
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

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>, done?: string) => once(async () => {
    try {
      await action();
      if (done) toast.success(done);
      await load();
    } catch (err: any) {
      toast.error('Could not save', { detail: err.message });
    }
  });

  const setStatus = (status: string) => run(() => api.put(`/api/crm/leads/${id}`, { status }), status === 'working' ? 'Marked as working' : 'Saved');

  const remove = () => once(async () => {
    if (!window.confirm(`Delete ${lead.name}? This can't be undone.`)) return;
    try {
      await api.delete(`/api/crm/leads/${id}`);
      toast.success('Lead deleted', { detail: lead.name });
      router.push('/saas/crm/leads');
    } catch (err: any) {
      setError(err.message);
    }
  });

  const merge = (other: any) => {
    if (window.confirm(`Merge ${other.name} into ${lead.name}? ${other.name} is removed and its timeline moves here.`)) {
      run(() => api.post(`/api/crm/leads/${id}/merge`, { drop_id: other.id }), `Merged ${other.name} in`);
    }
  };

  const owner = members.find(({ user_id }) => user_id === lead?.owner_id)?.email;
  const open = lead && ['new', 'working'].includes(lead.status);

  return (
    <div className="stack">
      <CrmNav />
      {error && <p className="error">{error}</p>}
      {!lead && !error && <RecordSkeleton />}
      {lead && (
        <>
          <RecordHeader
            name={lead.name}
            badge={<span className={`badge ${statusBadge[lead.status]}`}>{statusLabel[lead.status]}</span>}
            line={[lead.job_title, lead.company_name].filter(Boolean).join(' at ')}
            chips={[
              { icon: 'star', label: `${scoreLabel(lead.score)}, ${lead.score}`, title: 'Score' },
              lead.email && { icon: 'mail', label: lead.email, href: `mailto:${lead.email}`, external: true, title: 'Write an email' },
              lead.phone && { icon: 'phone', label: lead.phone, href: `tel:${lead.phone}`, external: true, title: 'Call' },
              lead.source && { icon: 'globe', label: lead.source, title: 'Source' },
              lead.campaign && { icon: 'target', label: lead.campaign, title: 'Campaign' },
              owner && { icon: 'user', label: owner, title: 'Owner' }
            ]}
            tags={lead.tags?.length ? <TagChips ids={lead.tags} tags={tags} /> : null}
            actions={(
              <>
                {whatsappNumber(lead.phone) && (
                  <a className="button" href={whatsappLink(lead.phone)} target="_blank" rel="noopener noreferrer" title="Opens a WhatsApp chat with this number">
                    <CrmIcon name="whatsapp" />WhatsApp
                  </a>
                )}
                {lead.status === 'new' && <button disabled={busy} onClick={() => setStatus('working')}>Start working</button>}
                {open && <button onClick={() => setForm('disqualify')}>Disqualify</button>}
                {lead.status === 'disqualified' && <button disabled={busy} onClick={() => setStatus('working')}>Reopen</button>}
                {lead.status !== 'converted' && <button onClick={() => setForm('edit')}>Edit</button>}
                <button disabled={busy} className="danger ghost" onClick={remove}>Delete</button>
                {open && <button className="primary" onClick={() => setForm('convert')}>Convert</button>}
              </>
            )}
          />

          {lead.status === 'converted' && (
            <div className="card">
              <p>
                Converted on {formatDate(lead.converted_at)}.
                {lead.converted_contact_id && <> <Link href={`/saas/crm/contact/${lead.converted_contact_id}`}>Open the contact</Link>.</>}
                {lead.converted_deal_id && <> <Link href={`/saas/crm/deal/${lead.converted_deal_id}`}>Open the deal</Link>.</>}
              </p>
            </div>
          )}
          {lead.disqualified_reason && <p className="notice">Disqualified because: {lead.disqualified_reason}</p>}

          <div className="card">
            <div className={styles.cardHead}>
              <div>
                <h2>Score {lead.score} <span className={`badge ${scoreBadge(lead.score)}`}>{scoreLabel(lead.score)}</span></h2>
                <p className="muted">What adds up to the score, from your lead scoring rules.</p>
              </div>
            </div>
            {lead.score_reasons.length === 0 && <p className="muted">No scoring rules match yet.</p>}
            {lead.score_reasons.length > 0 && (
              <Bars
                max={Math.max(...lead.score_reasons.map((reason: any) => Math.abs(Number(reason.points) || 0)))}
                rows={lead.score_reasons.map((reason: any) => ({
                  key: reason.label,
                  label: reason.label,
                  value: Math.abs(Number(reason.points) || 0),
                  tone: Number(reason.points) < 0 ? 'danger' as const : undefined,
                  text: `${reason.points > 0 ? '+' : ''}${reason.points}`,
                  title: `${reason.label}: ${reason.points > 0 ? '+' : ''}${reason.points} points`
                }))}
              />
            )}
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

          {form === 'edit' && <LeadForm initial={lead} onClose={() => setForm('')} onSaved={async () => { toast.success('Saved'); await load(); }} />}
          {form === 'disqualify' && <DisqualifyForm lead={lead} onClose={() => setForm('')} onSaved={async () => { toast.info('Lead disqualified', { detail: 'You can reopen it any time.' }); await load(); }} />}
          {form === 'convert' && <ConvertForm lead={lead} matches={matches.contacts} onClose={() => setForm('')} />}
        </>
      )}
    </div>
  );
}
