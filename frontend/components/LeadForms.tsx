import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { Actions, OwnerField, useForm, useTeam } from '@/components/CrmForms';
import { CustomInputs, useCustomFields } from '@/components/CustomFields';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';

export const SOURCES = ['Web form', 'Referral', 'Event', 'Cold call', 'Advertising', 'Import'];

export const scoreLabel = (score: number) => (score >= 60 ? 'Hot' : score >= 30 ? 'Warm' : 'Cold');
export const scoreBadge = (score: number) => (score >= 60 ? 'won' : score >= 30 ? 'sent' : '');

export const statusLabel: Record<string, string> = { new: 'New', working: 'Working', disqualified: 'Disqualified', converted: 'Converted' };
export const statusBadge: Record<string, string> = { new: 'open', working: 'sent', disqualified: 'lost', converted: 'won' };

export function LeadForm({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: (result?: any) => void }) {
  const members = useTeam();
  const fields = useCustomFields('lead');
  const { form, set, error, submit } = useForm(
    { name: '', email: '', phone: '', company_name: '', job_title: '', source: '', owner_id: '', notes: '', custom: {}, ...initial },
    ({ id, name, email, phone, company_name, job_title, source, owner_id, notes, custom }) => {
      const body = { name, email, phone, company_name, job_title, source, owner_id, notes, custom };
      return id ? api.put(`/api/crm/leads/${id}`, body) : api.post('/api/crm/leads', body);
    },
    onClose,
    onSaved
  );

  return (
    <Modal title={form.id ? `Edit ${form.name}` : 'New lead'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Company<input value={form.company_name || ''} onChange={(e) => set('company_name', e.target.value)} /></label>
          <label>Job title<input value={form.job_title || ''} onChange={(e) => set('job_title', e.target.value)} /></label>
          <label>Email<input type="email" value={form.email || ''} onChange={(e) => set('email', e.target.value)} /></label>
          <label>Phone<input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} /></label>
          <label>Source
            <input list="lead-sources" value={form.source || ''} onChange={(e) => set('source', e.target.value)} />
            <datalist id="lead-sources">{SOURCES.map((source) => <option key={source} value={source} />)}</datalist>
          </label>
          <OwnerField value={form.owner_id} members={members} onChange={(value) => set('owner_id', value)} empty={form.id ? 'Unassigned' : 'Assign automatically'} />
          <CustomInputs fields={fields} values={form.custom} onChange={(custom) => set('custom', custom)} />
        </div>
        <label style={{ marginTop: 12 }}>Notes<textarea rows={3} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        <Actions error={error} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function DisqualifyForm({ lead, onClose, onSaved }: { lead: any; onClose: () => void; onSaved: () => void }) {
  const { form, set, error, submit } = useForm(
    { disqualified_reason: '' },
    ({ disqualified_reason }) => api.put(`/api/crm/leads/${lead.id}`, { status: 'disqualified', disqualified_reason }),
    onClose,
    onSaved
  );

  return (
    <Modal title={`Why is ${lead.name} not a fit?`}>
      <form onSubmit={submit}>
        <label>Reason<input required value={form.disqualified_reason} onChange={(e) => set('disqualified_reason', e.target.value)} /></label>
        <Actions error={error} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function ConvertForm({ lead, matches, onClose }: { lead: any; matches: any[]; onClose: () => void }) {
  const router = useRouter();
  const sameEmail = matches.find((contact) => lead.email && contact.email?.toLowerCase() === lead.email);
  const [contactId, setContactId] = useState(sameEmail?.id || '');
  const [wantDeal, setWantDeal] = useState(true);
  const [deal, setDeal] = useState({ title: `${lead.company_name || lead.name} deal`, value: '', stage_id: '', expected_close: '' });
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/crm/pipelines').then(setPipelines).catch(() => setPipelines([]));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await api.post(`/api/crm/leads/${lead.id}/convert`, { contact_id: contactId, deal: wantDeal ? deal : null });
      router.push(result.deal_id ? `/saas/crm/deal/${result.deal_id}` : `/saas/crm/contact/${result.contact_id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Convert ${lead.name}`}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Contact
            <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">{sameEmail ? `Use ${sameEmail.name}, same email` : 'Create a new contact'}</option>
              {matches.map((contact) => <option key={contact.id} value={contact.id}>Add to {contact.name}{contact.company_name ? `, ${contact.company_name}` : ''}</option>)}
            </select>
          </label>
        </div>
        {lead.company_name && <p className="muted">{lead.company_name} is found or added to companies. The timeline moves across too.</p>}
        <label className="check"><input type="checkbox" checked={wantDeal} onChange={(e) => setWantDeal(e.target.checked)} />Create a deal</label>
        {wantDeal && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label>Title<input required value={deal.title} onChange={(e) => setDeal({ ...deal, title: e.target.value })} /></label>
            <label>Value<input type="number" min="0" step="0.01" value={deal.value} onChange={(e) => setDeal({ ...deal, value: e.target.value })} /></label>
            <label>Stage
              <select value={deal.stage_id} onChange={(e) => setDeal({ ...deal, stage_id: e.target.value })}>
                <option value="">First stage</option>
                {pipelines.map((pipeline) => (
                  <optgroup key={pipeline.id} label={pipeline.name}>
                    {[...pipeline.stages].sort((a, b) => a.position - b.position).filter((stage: any) => stage.kind === 'open').map((stage: any) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>Expected close<input type="date" value={deal.expected_close} onChange={(e) => setDeal({ ...deal, expected_close: e.target.value })} /></label>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Convert</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
