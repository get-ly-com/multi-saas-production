import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { CompanyForm, useTeam } from '@/components/CrmForms';
import { useCustomFields } from '@/components/CustomFields';
import SavedViews, { Filters, ListFilters, matchesFilters } from '@/components/SavedViews';
import BulkBar, { useSelection } from '@/components/BulkBar';
import { TagChips, TagFilter, tagNames, useTags } from '@/components/Tags';
import { api } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';

export default function Companies() {
  return <AppShell><CompaniesApp /></AppShell>;
}

function CompaniesApp() {
  const members = useTeam();
  const fields = useCustomFields('company');
  const tags = useTags();
  const [companies, setCompanies] = useState<any[]>([]);
  const [filters, setFilters] = useState<Filters>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      setCompanies(await api.get('/api/crm/companies'));
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

  const visible = companies.filter((company) => matchesFilters(company, filters, fields, [company.name, company.industry]));
  const selection = useSelection(visible.map(({ id }) => id));
  const ownerName = (id: string) => members.find(({ user_id }) => user_id === id)?.email || (id ? 'Former member' : 'Unassigned');

  const exportCsv = () => {
    const rows = selection.selected.length ? visible.filter(({ id }) => selection.has(id)) : visible;
    downloadCsv(`companies-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Name', 'Industry', 'Website', 'Phone', 'Owner', 'Tags', 'Contacts', 'Deals'],
      ...rows.map((row) => [row.name, row.industry, row.website, row.phone, ownerName(row.owner_id), tagNames(row.tags, tags), row.contacts?.[0]?.count ?? 0, row.deals?.[0]?.count ?? 0])
    ]);
  };

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Companies</h1>
        <div className="row-actions">
          <button disabled={!visible.length} onClick={exportCsv}>{selection.selected.length ? 'Export selected' : 'Export CSV'}</button>
          <button className="primary" onClick={() => setAdding(true)}>New company</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card stack">
        <SavedViews entity="company" filters={filters} onApply={setFilters} />
        <div className="form-grid">
          <label>Search<input aria-label="Filter companies" placeholder="Name or industry" value={filters.search || ''} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
          <TagFilter value={filters.tag || ''} onChange={(tag) => setFilters({ ...filters, tag })} tags={tags} />
          <ListFilters filters={filters} onChange={setFilters} members={members} fields={fields} />
        </div>
      </div>

      <BulkBar entity="company" selected={selection.selected} onClear={selection.clear} tags={tags} members={members}
        onDone={async (message) => { setNotice(message); await load(); }} />

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th className="pick"><input type="checkbox" aria-label="Select all shown" checked={selection.all} onChange={selection.toggleAll} /></th><th>Name</th><th>Industry</th><th>Phone</th><th>Tags</th><th className="num">Contacts</th><th className="num">Deals</th></tr></thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={7} className="empty">{companies.length ? 'No matches' : 'No companies yet'}</td></tr>}
              {visible.map((company) => (
                <tr key={company.id} className={selection.has(company.id) ? 'picked' : ''}>
                  <td className="pick"><input type="checkbox" aria-label={`Select ${company.name}`} checked={selection.has(company.id)} onChange={() => selection.toggle(company.id)} /></td>
                  <td className="wrap"><Link href={`/saas/crm/company/${company.id}`}>{company.name}</Link></td>
                  <td className="wrap">{company.industry || '—'}</td>
                  <td>{company.phone || '—'}</td>
                  <td className="wrap"><TagChips ids={company.tags} tags={tags} /></td>
                  <td className="num">{company.contacts?.[0]?.count ?? 0}</td>
                  <td className="num">{company.deals?.[0]?.count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding && <CompanyForm onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}
