import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { CompanyForm } from '@/components/CrmForms';
import { api } from '@/lib/api';

export default function Companies() {
  return <AppShell><CompaniesApp /></AppShell>;
}

function CompaniesApp() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [search, setSearch] = useState('');
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

  const query = search.trim().toLowerCase();
  const visible = companies.filter((company) => [company.name, company.industry].some((field) => (field || '').toLowerCase().includes(query)));

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Companies</h1>
        <button className="primary" onClick={() => setAdding(true)}>New company</button>
      </div>

      {error && <p className="error">{error}</p>}

      <input aria-label="Filter companies" placeholder="Filter by name or industry" value={search} onChange={(e) => setSearch(e.target.value)} />

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
