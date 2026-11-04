import Link from 'next/link';
import { ChangeEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { ContactForm, useTeam } from '@/components/CrmForms';
import { useCustomFields } from '@/components/CustomFields';
import SavedViews, { Filters, ListFilters, matchesFilters } from '@/components/SavedViews';
import BulkBar, { useSelection } from '@/components/BulkBar';
import { TagChips, TagFilter, tagNames, useTags } from '@/components/Tags';
import { api, formatDate, today } from '@/lib/api';
import { downloadCsv, readPeople } from '@/lib/csv';

export default function Contacts() {
  return <AppShell><ContactsApp /></AppShell>;
}

function ContactsApp() {
  const members = useTeam();
  const fields = useCustomFields('contact');
  const tags = useTags();
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
  const selection = useSelection(visible.map(({ id }) => id));
  const ownerName = (id: string) => members.find(({ user_id }) => user_id === id)?.email || (id ? 'Former member' : 'Unassigned');

  const exportCsv = () => {
    const rows = selection.selected.length ? visible.filter(({ id }) => selection.has(id)) : visible;
    downloadCsv(`contacts-${today()}.csv`, [
      ['Name', 'Job title', 'Company', 'Email', 'Phone', 'Owner', 'Tags', 'Source', 'Added'],
      ...rows.map((row) => [row.name, row.job_title, row.company?.name, row.email, row.phone, ownerName(row.owner_id), tagNames(row.tags, tags), row.source, formatDate(row.created_at)])
    ]);
  };

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Contacts</h1>
        <div className="row-actions">
          <label className="button">Import CSV<input type="file" accept=".csv,text/csv" hidden onChange={importFile} /></label>
          <button disabled={!visible.length} onClick={exportCsv}>{selection.selected.length ? 'Export selected' : 'Export CSV'}</button>
          <button className="primary" onClick={() => setForm({})}>New contact</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card stack">
        <SavedViews entity="contact" filters={filters} onApply={setFilters} />
        <div className="form-grid">
          <label>Search<input aria-label="Filter contacts" placeholder="Name, email or company" value={filters.search || ''} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
          <TagFilter value={filters.tag || ''} onChange={(tag) => setFilters({ ...filters, tag })} tags={tags} />
          <ListFilters filters={filters} onChange={setFilters} members={members} fields={fields} />
        </div>
      </div>

      <BulkBar entity="contact" selected={selection.selected} onClear={selection.clear} tags={tags} members={members}
        onDone={async (message) => { setNotice(message); await load(); }} />

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th className="pick"><input type="checkbox" aria-label="Select all shown" checked={selection.all} onChange={selection.toggleAll} /></th><th>Name</th><th>Job title</th><th>Company</th><th>Email</th><th>Phone</th><th>Tags</th></tr></thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={7} className="empty">{contacts.length ? 'No matches' : 'No contacts yet'}</td></tr>}
              {visible.map((contact) => (
                <tr key={contact.id} className={selection.has(contact.id) ? 'picked' : ''}>
                  <td className="pick"><input type="checkbox" aria-label={`Select ${contact.name}`} checked={selection.has(contact.id)} onChange={() => selection.toggle(contact.id)} /></td>
                  <td className="wrap"><Link href={`/saas/crm/contact/${contact.id}`}>{contact.name}</Link></td>
                  <td className="wrap">{contact.job_title || '—'}</td>
                  <td className="wrap">{contact.company ? <Link href={`/saas/crm/company/${contact.company.id}`}>{contact.company.name}</Link> : '—'}</td>
                  <td>{contact.email || '—'}</td>
                  <td>{contact.phone || '—'}</td>
                  <td className="wrap"><TagChips ids={contact.tags} tags={tags} /></td>
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
