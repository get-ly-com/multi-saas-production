import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';

export const useTeam = () => {
  const [members, setMembers] = useState<any[]>([]);

  useEffect(() => {
    api.get('/api/team').then((team) => setMembers(team.members)).catch(() => setMembers([]));
  }, []);

  return members;
};

function OwnerField({ value, members, onChange }: { value: string; members: any[]; onChange: (value: string) => void }) {
  return (
    <label>Owner
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Unassigned</option>
        {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
      </select>
    </label>
  );
}

function useForm(initial: any, save: (form: any) => Promise<unknown>, onClose: () => void, onSaved: (result?: any) => void) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm((current: any) => ({ ...current, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await save(form);
      await onSaved(result);
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return { form, set, error, submit };
}

const Actions = ({ error, onClose }: { error: string; onClose: () => void }) => (
  <>
    {error && <p className="error">{error}</p>}
    <div className="form-actions">
      <button className="primary">Save</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  </>
);

type FormProps = { initial?: any; onClose: () => void; onSaved: (result?: any) => void };

export function CompanyForm({ initial, onClose, onSaved }: FormProps) {
  const members = useTeam();
  const { form, set, error, submit } = useForm(
    { name: '', website: '', industry: '', phone: '', notes: '', owner_id: '', ...initial },
    ({ id, name, website, industry, phone, notes, owner_id }) => {
      const body = { name, website, industry, phone, notes, owner_id };
      return id ? api.put(`/api/crm/companies/${id}`, body) : api.post('/api/crm/companies', body);
    },
    onClose,
    onSaved
  );

  return (
    <Modal title={form.id ? `Edit ${form.name}` : 'New company'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Website<input value={form.website || ''} onChange={(e) => set('website', e.target.value)} /></label>
          <label>Industry<input value={form.industry || ''} onChange={(e) => set('industry', e.target.value)} /></label>
          <label>Phone<input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} /></label>
          <OwnerField value={form.owner_id} members={members} onChange={(value) => set('owner_id', value)} />
        </div>
        <label style={{ marginTop: 12 }}>Notes<textarea rows={3} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        <Actions error={error} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function ContactForm({ initial, onClose, onSaved }: FormProps) {
  const members = useTeam();
  const [companies, setCompanies] = useState<any[]>([]);
  const { form, set, error, submit } = useForm(
    { name: '', email: '', phone: '', job_title: '', company_id: '', notes: '', owner_id: '', ...initial },
    ({ id, name, email, phone, job_title, company_id, notes, owner_id }) => {
      const body = { name, email, phone, job_title, company_id, notes, owner_id };
      return id ? api.put(`/api/crm/contacts/${id}`, body) : api.post('/api/crm/contacts', body);
    },
    onClose,
    onSaved
  );

  useEffect(() => {
    api.get('/api/crm/companies').then(setCompanies).catch(() => setCompanies([]));
  }, []);

  return (
    <Modal title={form.id ? `Edit ${form.name}` : 'New contact'}>
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
        </div>
        <label style={{ marginTop: 12 }}>Notes<textarea rows={3} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        <Actions error={error} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function DealForm({ initial, onClose, onSaved }: FormProps) {
  const members = useTeam();
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const { form, set, error, submit } = useForm(
    { title: '', value: '', stage_id: '', contact_id: '', company_id: '', owner_id: '', expected_close: '', ...initial },
    ({ id, title, value, stage_id, contact_id, company_id, owner_id, expected_close }) => {
      const body = { title, value, stage_id, contact_id, company_id, owner_id, expected_close };
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
    <Modal title={form.id ? `Edit ${form.title}` : 'New deal'}>
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
        </div>
        <Actions error={error} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function LostForm({ deal, stageId, onClose, onSaved }: { deal: any; stageId: string; onClose: () => void; onSaved: () => void }) {
  const { form, set, error, submit } = useForm(
    { lost_reason: '' },
    ({ lost_reason }) => api.put(`/api/crm/deals/${deal.id}`, { stage_id: stageId, lost_reason }),
    onClose,
    onSaved
  );

  return (
    <Modal title={`Why was ${deal.title} lost?`}>
      <form onSubmit={submit}>
        <label>Reason<input required value={form.lost_reason} onChange={(e) => set('lost_reason', e.target.value)} /></label>
        <Actions error={error} onClose={onClose} />
      </form>
    </Modal>
  );
}
