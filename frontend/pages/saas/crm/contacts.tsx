import Link from 'next/link';
import { ChangeEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { ContactForm, useTeam } from '@/components/CrmForms';
import { useCustomFields } from '@/components/CustomFields';
import SavedViews, { Filters, ListFilters, matchesFilters } from '@/components/SavedViews';
import { api } from '@/lib/api';
import { readPeople } from '@/lib/csv';

export default function Contacts() {
  return <AppShell><ContactsApp /></AppShell>;
}

function ContactsApp() {
  const members = useTeam();
  const fields = useCustomFields('contact');
  const [contacts, setContacts] = useState<any[]>([]);
  const [filters, setFilters] = useState<Filters>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<any>(null);

  const load = async () => {
    try {
      setContacts(await api.get('/api/crm/contacts'));
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

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const result = await api.post('/api/crm/contacts/import', { rows: readPeople(await file.text()) });
      setNotice(`Imported ${result.created} contacts. Skipped ${result.skipped} with no name or an email already here.`);
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  };

  const visible = contacts.filter((contact) => matchesFilters(contact, filters, fields, [contact.name, contact.email, contact.company?.name]));

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Contacts</h1>
        <div className="row-actions">
          <label className="button">Import CSV<input type="file" accept=".csv,text/csv" hidden onChange={importFile} /></label>
          <button className="primary" onClick={() => setForm({})}>New contact</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card stack">
        <SavedViews entity="contact" filters={filters} onApply={setFilters} />
        <div className="form-grid">
          <label>Search<input aria-label="Filter contacts" placeholder="Name, email or company" value={filters.search || ''} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
          <ListFilters filters={filters} onChange={setFilters} members={members} fields={fields} />
        </div>
      </div>

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Name</th><th>Job title</th><th>Company</th><th>Email</th><th>Phone</th></tr></thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={5} className="empty">{contacts.length ? 'No matches' : 'No contacts yet'}</td></tr>}
              {visible.map((contact) => (
                <tr key={contact.id}>
                  <td className="wrap"><Link href={`/saas/crm/contact/${contact.id}`}>{contact.name}</Link></td>
                  <td className="wrap">{contact.job_title || '—'}</td>
                  <td className="wrap">{contact.company ? <Link href={`/saas/crm/company/${contact.company.id}`}>{contact.company.name}</Link> : '—'}</td>
                  <td>{contact.email || '—'}</td>
                  <td>{contact.phone || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {form && <ContactForm initial={form} onClose={() => setForm(null)} onSaved={load} />}
    </div>
  );
}
