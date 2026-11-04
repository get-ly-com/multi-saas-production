import { FormEvent, useEffect, useState } from 'react';
import { CustomInputs, useCustomFields } from '@/components/CustomFields';
import Modal from '@/components/Modal';
import { TagPicker, useTags } from '@/components/Tags';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import { CATEGORIES } from '@/lib/forecast';

export const useTeam = () => {
  const [members, setMembers] = useState<any[]>([]);

  useEffect(() => {
    api.get('/api/team').then((team) => setMembers(team.members)).catch(() => setMembers([]));
  }, []);

  return members;
};

export function OwnerField({ value, members, onChange, empty = 'Unassigned' }: { value: string; members: any[]; onChange: (value: string) => void; empty?: string }) {
  return (
    <label>Owner
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{empty}</option>
        {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
      </select>
    </label>
  );
}

export function useForm(initial: any, save: (form: any) => Promise<unknown>, onClose: () => void, onSaved: (result?: any) => void) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const { busy, run } = useSubmit();
  const set = (field: string, value: unknown) => setForm((current: any) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setError('');
      try {
        const result = await save(form);
        await onSaved(result);
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return { form, set, error, submit, busy };
}

export const Actions = ({ error, onClose, busy = false }: { error: string; onClose: () => void; busy?: boolean }) => (
  <>
    {error && <p className="error">{error}</p>}
    <div className="form-actions">
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  </>
);

type FormProps = { initial?: any; onClose: () => void; onSaved: (result?: any) => void };

export function CompanyForm({ initial, onClose, onSaved }: FormProps) {
  const members = useTeam();
  const fields = useCustomFields('company');
  const tags = useTags();
  const { form, set, error, submit, busy } = useForm(
    { name: '', website: '', industry: '', phone: '', notes: '', owner_id: '', custom: {}, tags: [], ...initial },
    ({ id, name, website, industry, phone, notes, owner_id, custom, tags }) => {
      const body = { name, website, industry, phone, notes, owner_id, custom, tags: tags || [] };
      return id ? api.put(`/api/crm/companies/${id}`, body) : api.post('/api/crm/companies', body);
    },
    onClose,
    onSaved
  );

  return (
    <Modal title={form.id ? `Edit ${form.name}` : 'New company'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Website<input value={form.website || ''} onChange={(e) => set('website', e.target.value)} /></label>
          <label>Industry<input value={form.industry || ''} onChange={(e) => set('industry', e.target.value)} /></label>
          <label>Phone<input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} /></label>
          <OwnerField value={form.owner_id} members={members} onChange={(value) => set('owner_id', value)} />
          <CustomInputs fields={fields} values={form.custom} onChange={(custom) => set('custom', custom)} />
        </div>
        <TagPicker value={form.tags} onChange={(ids) => set('tags', ids)} tags={tags} />
        <label style={{ marginTop: 12 }}>Notes<textarea rows={3} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        <Actions error={error} onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}

export function ContactForm({ initial, onClose, onSaved }: FormProps) {
  const members = useTeam();
  const fields = useCustomFields('contact');
  const tags = useTags();
  const [companies, setCompanies] = useState<any[]>([]);
  const { form, set, error, submit, busy } = useForm(
    { name: '', email: '', phone: '', job_title: '', company_id: '', notes: '', owner_id: '', custom: {}, tags: [], ...initial },
    ({ id, name, email, phone, job_title, company_id, notes, owner_id, custom, tags }) => {
      const body = { name, email, phone, job_title, company_id, notes, owner_id, custom, tags: tags || [] };
      return id ? api.put(`/api/crm/contacts/${id}`, body) : api.post('/api/crm/contacts', body);
    },
    onClose,
    onSaved
  );

  useEffect(() => {
    api.get('/api/crm/companies').then(setCompanies).catch(() => setCompanies([]));
  }, []);

  return (
    <Modal title={form.id ? `Edit ${form.name}` : 'New contact'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Job title<input value={form.job_title || ''} onChange={(e) => set('job_title', e.target.value)} /></label>
          <label>Company
            <select value={form.company_id || ''} onChange={(e) => set('company_id', e.target.value)}>
              <option value="">None</option>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <label>Email<input type="email" value={form.email || ''} onChange={(e) => set('email', e.target.value)} /></label>
          <label>Phone<input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} /></label>
          <OwnerField value={form.owner_id} members={members} onChange={(value) => set('owner_id', value)} />
          <CustomInputs fields={fields} values={form.custom} onChange={(custom) => set('custom', custom)} />
        </div>
        <TagPicker value={form.tags} onChange={(ids) => set('tags', ids)} tags={tags} />
        <label style={{ marginTop: 12 }}>Notes<textarea rows={3} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        <Actions error={error} onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}

export function DealForm({ initial, onClose, onSaved }: FormProps) {
  const members = useTeam();
  const fields = useCustomFields('deal');
  const tags = useTags();
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const { form, set, error, submit, busy } = useForm(
    { title: '', value: '', stage_id: '', contact_id: '', company_id: '', owner_id: '', expected_close: '', forecast_category: '', custom: {}, tags: [], ...initial },
    ({ id, title, value, stage_id, contact_id, company_id, owner_id, expected_close, forecast_category, custom, tags }) => {
      const body = { title, value, stage_id, contact_id, company_id, owner_id, expected_close, forecast_category: forecast_category || '', custom, tags: tags || [] };
      return id ? api.put(`/api/crm/deals/${id}`, body) : api.post('/api/crm/deals', body);
    },
    onClose,
    onSaved
  );

  useEffect(() => {
    Promise.all([api.get('/api/crm/pipelines'), api.get('/api/crm/contacts'), api.get('/api/crm/companies')])
      .then(([pipelineRows, contactRows, companyRows]) => {
        setPipelines(pipelineRows);
        setContacts(contactRows);
        setCompanies(companyRows);
        if (!form.stage_id) set('stage_id', pipelineRows[0]?.stages.sort((a: any, b: any) => a.position - b.position)[0]?.id || '');
      })
      .catch(() => null);
  }, []);

  return (
    <Modal title={form.id ? `Edit ${form.title}` : 'New deal'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Title<input required value={form.title} onChange={(e) => set('title', e.target.value)} /></label>
          <label>Value<input type="number" min="0" step="0.01" value={form.value ?? ''} onChange={(e) => set('value', e.target.value)} /></label>
          <label>Stage
            <select required value={form.stage_id} onChange={(e) => set('stage_id', e.target.value)}>
              {pipelines.map((pipeline) => (
                <optgroup key={pipeline.id} label={pipeline.name}>
                  {[...pipeline.stages].sort((a, b) => a.position - b.position).map((stage: any) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label>Expected close<input type="date" value={form.expected_close || ''} onChange={(e) => set('expected_close', e.target.value)} /></label>
          <label>Forecast
            <select value={form.forecast_category || ''} onChange={(e) => set('forecast_category', e.target.value)}>
              <option value="">From the stage</option>
              {CATEGORIES.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label>Contact
            <select value={form.contact_id || ''} onChange={(e) => set('contact_id', e.target.value)}>
              <option value="">None</option>
              {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
            </select>
          </label>
          <label>Company
            <select value={form.company_id || ''} onChange={(e) => set('company_id', e.target.value)}>
              <option value="">From the contact</option>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <OwnerField value={form.owner_id} members={members} onChange={(value) => set('owner_id', value)} />
          <CustomInputs fields={fields} values={form.custom} onChange={(custom) => set('custom', custom)} />
        </div>
        <TagPicker value={form.tags} onChange={(ids) => set('tags', ids)} tags={tags} />
        <Actions error={error} onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}

export function LostForm({ deal, stageId, onClose, onSaved }: { deal: any; stageId: string; onClose: () => void; onSaved: () => void }) {
  const [reasons, setReasons] = useState<any[]>([]);
  const [other, setOther] = useState(false);

  useEffect(() => {
    api.get('/api/crm/lost-reasons').then(setReasons).catch(() => setReasons([]));
  }, []);

  const { form, set, error, submit, busy } = useForm(
    { lost_reason: '' },
    ({ lost_reason }) => api.put(`/api/crm/deals/${deal.id}`, { stage_id: stageId, lost_reason }),
    onClose,
    onSaved
  );

  return (
    <Modal title={`Why was ${deal.title} lost?`} onClose={onClose}>
      <form onSubmit={submit}>
        {reasons.length > 0 && !other ? (
          <label>Reason
            <select required value={form.lost_reason} onChange={(e) => (e.target.value === '__other' ? (setOther(true), set('lost_reason', '')) : set('lost_reason', e.target.value))}>
              <option value="">Choose a reason</option>
              {reasons.map((reason) => <option key={reason.id} value={reason.name}>{reason.name}</option>)}
              <option value="__other">Something else…</option>
            </select>
          </label>
        ) : (
          <label>Reason<input required maxLength={200} value={form.lost_reason} onChange={(e) => set('lost_reason', e.target.value)} /></label>
        )}
        <Actions error={error} onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}
