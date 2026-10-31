import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, money } from '@/lib/api';

const STAGES = ['prospecting', 'qualified', 'proposal', 'won', 'lost'];
const blankContact = { name: '', email: '', phone: '', company: '', notes: '' };
const blankDeal = { title: '', value: '', stage: 'prospecting', contact_id: '' };

export default function Crm() {
  return <AppShell><CrmApp /></AppShell>;
}

function CrmApp() {
  const [tab, setTab] = useState<'pipeline' | 'contacts'>('pipeline');
  const [contacts, setContacts] = useState<any[]>([]);
  const [deals, setDeals] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [contactForm, setContactForm] = useState<any>(null);
  const [dealForm, setDealForm] = useState<any>(null);

  const load = async () => {
    try {
      const [contactRows, dealRows] = await Promise.all([
        api.get('/api/crm/contacts'),
        api.get('/api/crm/deals')
      ]);
      setContacts(contactRows);
      setDeals(dealRows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = (path: string, label: string) => {
    if (window.confirm(`Delete this ${label}? This can't be undone.`)) {
      run(() => api.delete(path));
    }
  };

  const query = search.trim().toLowerCase();
  const visibleContacts = contacts.filter((contact) =>
    [contact.name, contact.email, contact.company].some((field) => (field || '').toLowerCase().includes(query))
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1>CRM</h1>
        {tab === 'pipeline'
          ? <button className="primary" onClick={() => setDealForm(blankDeal)}>New deal</button>
          : <button className="primary" onClick={() => setContactForm(blankContact)}>New contact</button>}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="tabs">
        <button className={tab === 'pipeline' ? 'active' : ''} onClick={() => setTab('pipeline')}>Pipeline</button>
        <button className={tab === 'contacts' ? 'active' : ''} onClick={() => setTab('contacts')}>Contacts</button>
      </div>

      {loading ? <p className="empty">Loading…</p> : tab === 'pipeline' ? (
        <div className="board">
          {STAGES.map((stage) => {
            const stageDeals = deals.filter((deal) => deal.stage === stage);
            const total = stageDeals.reduce((sum, deal) => sum + Number(deal.value || 0), 0);
            return (
              <div className="column" key={stage}>
                <div className="column-head"><span>{stage}</span><span>{money(total)}</span></div>
                {stageDeals.map((deal) => (
                  <div className="deal" key={deal.id}>
                    <div className="deal-title">{deal.title}</div>
                    <div className="deal-meta">{money(deal.value)}{deal.contact ? ` · ${deal.contact.name}` : ''}</div>
                    <select aria-label="Stage" value={deal.stage} onChange={(e) => run(() => api.put(`/api/crm/deals/${deal.id}`, { stage: e.target.value }))}>
                      {STAGES.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                    <div className="row-actions" style={{ marginTop: 6, justifyContent: 'flex-start' }}>
                      <button className="link" onClick={() => setDealForm({ ...deal, value: deal.value ?? '', contact_id: deal.contact_id || '' })}>Edit</button>
                      <button className="link" onClick={() => remove(`/api/crm/deals/${deal.id}`, 'deal')}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="stack">
          <input aria-label="Search contacts" placeholder="Search by name, email or company" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th /></tr></thead>
              <tbody>
                {visibleContacts.length === 0 && <tr><td colSpan={5} className="empty">{contacts.length ? 'No matches' : 'No contacts yet'}</td></tr>}
                {visibleContacts.map((contact) => (
                  <tr key={contact.id}>
                    <td className="wrap">{contact.name}</td>
                    <td className="wrap">{contact.company || '—'}</td>
                    <td>{contact.email || '—'}</td>
                    <td>{contact.phone || '—'}</td>
                    <td>
                      <div className="row-actions">
                        <button onClick={() => setContactForm({ ...blankContact, ...contact, email: contact.email || '', phone: contact.phone || '', company: contact.company || '', notes: contact.notes || '' })}>Edit</button>
                        <button className="danger" onClick={() => remove(`/api/crm/contacts/${contact.id}`, 'contact and its deals')}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {contactForm && <ContactForm initial={contactForm} onClose={() => setContactForm(null)} onSaved={load} />}
      {dealForm && <DealForm initial={dealForm} contacts={contacts} onClose={() => setDealForm(null)} onSaved={load} />}
    </div>
  );
}

function ContactForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { name, email, phone, company, notes } = form;
    const body = { name, email, phone, company, notes };
    try {
      if (form.id) await api.put(`/api/crm/contacts/${form.id}`, body);
      else await api.post('/api/crm/contacts', body);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? 'Edit contact' : 'New contact'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Company<input value={form.company} onChange={(e) => set('company', e.target.value)} /></label>
          <label>Email<input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
          <label>Phone<input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        </div>
        <label style={{ marginTop: 12 }}>Notes<textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function DealForm({ initial, contacts, onClose, onSaved }: { initial: any; contacts: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { title, value, stage, contact_id } = form;
    const body = { title, value, stage, contact_id };
    try {
      if (form.id) await api.put(`/api/crm/deals/${form.id}`, body);
      else await api.post('/api/crm/deals', body);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? 'Edit deal' : 'New deal'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Title<input required value={form.title} onChange={(e) => set('title', e.target.value)} /></label>
          <label>Value<input type="number" min="0" step="0.01" value={form.value} onChange={(e) => set('value', e.target.value)} /></label>
          <label>Stage
            <select value={form.stage} onChange={(e) => set('stage', e.target.value)}>
              {STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
            </select>
          </label>
          <label>Contact
            <select value={form.contact_id} onChange={(e) => set('contact_id', e.target.value)}>
              <option value="">None</option>
              {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
