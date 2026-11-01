import Link from 'next/link';
import { ChangeEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { ContactForm } from '@/components/CrmForms';
import { api } from '@/lib/api';
import { parseCsv } from '@/lib/csv';

// Spreadsheet exports name these columns in many ways
const COLUMN_NAMES: Record<string, string[]> = {
  name: ['name', 'full name', 'contact', 'contact name'],
  first: ['first name', 'firstname', 'given name'],
  last: ['last name', 'lastname', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'telephone', 'phone number'],
  company: ['company', 'account', 'organization', 'organisation', 'company name'],
  job_title: ['title', 'job title', 'position', 'role']
};

const readRows = (text: string) => {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];

  const headers = head.map((cell) => cell.trim().toLowerCase());
  const column = (field: string) => headers.findIndex((header) => COLUMN_NAMES[field].includes(header));
  const cell = (row: string[], field: string) => (column(field) >= 0 ? (row[column(field)] || '').trim() : '');

  return rows.map((row) => ({
    name: cell(row, 'name') || `${cell(row, 'first')} ${cell(row, 'last')}`.trim(),
    email: cell(row, 'email'),
    phone: cell(row, 'phone'),
    company: cell(row, 'company'),
    job_title: cell(row, 'job_title')
  }));
};

export default function Contacts() {
  return <AppShell><ContactsApp /></AppShell>;
}

function ContactsApp() {
  const [contacts, setContacts] = useState<any[]>([]);
  const [search, setSearch] = useState('');
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
      const result = await api.post('/api/crm/contacts/import', { rows: readRows(await file.text()) });
      setNotice(`Imported ${result.created} contacts. Skipped ${result.skipped} with no name or an email already here.`);
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  };

  const query = search.trim().toLowerCase();
  const visible = contacts.filter((contact) =>
    [contact.name, contact.email, contact.company?.name].some((field) => (field || '').toLowerCase().includes(query)));

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

      <input aria-label="Filter contacts" placeholder="Filter by name, email or company" value={search} onChange={(e) => setSearch(e.target.value)} />

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
