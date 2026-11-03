import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const SECTIONS = [
  { name: 'Today', path: '/saas/crm' },
  { name: 'Pipeline', path: '/saas/crm/pipeline' },
  { name: 'Forecast', path: '/saas/crm/forecast' },
  { name: 'Leads', path: '/saas/crm/leads' },
  { name: 'Contacts', path: '/saas/crm/contacts' },
  { name: 'Companies', path: '/saas/crm/companies' },
  { name: 'Quotes', path: '/saas/crm/quotes' },
  { name: 'Activities', path: '/saas/crm/tasks' },
  { name: 'Reports', path: '/saas/crm/reports' },
  { name: 'Duplicates', path: '/saas/crm/duplicates' },
  { name: 'Automation', path: '/saas/crm/automation' },
  { name: 'Settings', path: '/saas/crm/settings' }
];

export default function CrmNav() {
  const { pathname } = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any>(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return setResults(null);
    let current = true;
    const timer = setTimeout(() => {
      api.get(`/api/crm/search?q=${encodeURIComponent(text)}`)
        .then((found) => current && setResults(found))
        .catch(() => current && setResults(null));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);

  const empty = results && !results.contacts.length && !results.companies.length && !results.deals.length && !results.leads.length;

  return (
    <div className="crm-nav">
      <nav className="subnav">
        {SECTIONS.map(({ name, path }) => (
          <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
        ))}
      </nav>
      <div className="crm-search">
        <input aria-label="Search the CRM" placeholder="Search the CRM" value={query} onChange={(e) => setQuery(e.target.value)} />
        {results && (
          <div className="crm-results">
            {empty && <p className="muted">No matches</p>}
            {results.leads.map((row: any) => <Link key={row.id} href={`/saas/crm/lead/${row.id}`}>{row.name}<span className="muted"> · lead</span></Link>)}
            {results.contacts.map((row: any) => <Link key={row.id} href={`/saas/crm/contact/${row.id}`}>{row.name}<span className="muted"> · contact</span></Link>)}
            {results.companies.map((row: any) => <Link key={row.id} href={`/saas/crm/company/${row.id}`}>{row.name}<span className="muted"> · company</span></Link>)}
            {results.deals.map((row: any) => <Link key={row.id} href={`/saas/crm/deal/${row.id}`}>{row.title}<span className="muted"> · deal</span></Link>)}
          </div>
        )}
      </div>
    </div>
  );
}
