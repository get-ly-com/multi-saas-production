import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { CompanyForm, useTeam } from '@/components/CrmForms';
import { useCustomFields } from '@/components/CustomFields';
import SavedViews, { Filters, ListFilters, matchesFilters } from '@/components/SavedViews';
import { api } from '@/lib/api';

export default function Companies() {
  return <AppShell><CompaniesApp /></AppShell>;
}

function CompaniesApp() {
  const members = useTeam();
  const fields = useCustomFields('company');
  const [companies, setCompanies] = useState<any[]>([]);
  const [filters, setFilters] = useState<Filters>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Companies</h1>
        <button className="primary" onClick={() => setAdding(true)}>New company</button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card stack">
        <SavedViews entity="company" filters={filters} onApply={setFilters} />
        <div className="form-grid">
          <label>Search<input aria-label="Filter companies" placeholder="Name or industry" value={filters.search || ''} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
          <ListFilters filters={filters} onChange={setFilters} members={members} fields={fields} />
        </div>
      </div>

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Name</th><th>Industry</th><th>Phone</th><th className="num">Contacts</th><th className="num">Deals</th></tr></thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={5} className="empty">{companies.length ? 'No matches' : 'No companies yet'}</td></tr>}
              {visible.map((company) => (
                <tr key={company.id}>
                  <td className="wrap"><Link href={`/saas/crm/company/${company.id}`}>{company.name}</Link></td>
                  <td className="wrap">{company.industry || '—'}</td>
                  <td>{company.phone || '—'}</td>
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
