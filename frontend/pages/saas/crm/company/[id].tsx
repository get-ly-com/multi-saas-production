import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Billing from '@/components/Billing';
import CrmNav from '@/components/CrmNav';
import { TagChips, useTags } from '@/components/Tags';
import { CompanyForm, ContactForm, DealForm } from '@/components/CrmForms';
import { CustomValues } from '@/components/CustomFields';
import Timeline from '@/components/Timeline';
import { api, money } from '@/lib/api';

export default function Company() {
  return <AppShell><CompanyApp /></AppShell>;
}

function CompanyApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [company, setCompany] = useState<any>(null);
  const [contacts, setContacts] = useState<any[]>([]);
  const [deals, setDeals] = useState<any[]>([]);
  const [error, setError] = useState('');
  const tags = useTags();
  const [form, setForm] = useState('');

  const load = async () => {
    try {
      const [row, contactRows, dealRows] = await Promise.all([
        api.get(`/api/crm/companies/${id}`),
        api.get(`/api/crm/contacts?company_id=${id}`),
        api.get(`/api/crm/deals?company_id=${id}`)
      ]);
      setCompany(row);
      setContacts(contactRows);
      setDeals(dealRows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (id) load();
  }, [id]);

  const remove = async () => {
    if (!window.confirm(`Delete ${company.name}? Its contacts, deals and timeline stay.`)) return;
    try {
      await api.delete(`/api/crm/companies/${id}`);
      router.push('/saas/crm/companies');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const openValue = deals.filter((deal) => deal.stage?.kind === 'open').reduce((sum, deal) => sum + Number(deal.value || 0), 0);
  const wonValue = deals.filter((deal) => deal.stage?.kind === 'won').reduce((sum, deal) => sum + Number(deal.value || 0), 0);

  return (
    <div className="stack">
      <CrmNav />
      {error && <p className="error">{error}</p>}
      {company && (
        <>
          <div className="page-head">
            <div>
              <h1>{company.name}</h1>
              <TagChips ids={company.tags} tags={tags} />
              <p className="muted">{[company.industry, company.website, company.phone].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="row-actions">
              <button onClick={() => setForm('contact')}>New contact</button>
              <button onClick={() => setForm('deal')}>New deal</button>
              <button onClick={() => setForm('edit')}>Edit</button>
              <button className="danger" onClick={remove}>Delete</button>
            </div>
          </div>
          <div className="stats">
            <div className="card"><div className="stat-label">Open deals</div><div className="stat-value">{money(openValue)}</div></div>
            <div className="card"><div className="stat-label">Won so far</div><div className="stat-value">{money(wonValue)}</div></div>
          </div>
          {company.notes && <div className="card wrap">{company.notes}</div>}
          <CustomValues entity="company" values={company.custom} />
          <div className="card table-wrap">
            <h2>People</h2>
            <table>
              <tbody>
                {contacts.length === 0 && <tr><td className="empty">No contacts yet</td></tr>}
                {contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td className="wrap"><Link href={`/saas/crm/contact/${contact.id}`}>{contact.name}</Link></td>
                    <td className="wrap">{contact.job_title || '—'}</td>
                    <td>{contact.email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card table-wrap">
            <h2>Deals</h2>
            <table>
              <tbody>
                {deals.length === 0 && <tr><td className="empty">No deals yet</td></tr>}
                {deals.map((deal) => (
                  <tr key={deal.id}>
                    <td className="wrap"><Link href={`/saas/crm/deal/${deal.id}`}>{deal.title}</Link></td>
                    <td><span className={`badge ${deal.stage?.kind}`}>{deal.stage?.name}</span></td>
                    <td className="num">{money(deal.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Billing query={`company_id=${company.id}`} />
          <Timeline links={{ company_id: company.id }} />
          {form === 'edit' && <CompanyForm initial={company} onClose={() => setForm('')} onSaved={load} />}
          {form === 'contact' && <ContactForm initial={{ company_id: company.id }} onClose={() => setForm('')} onSaved={load} />}
          {form === 'deal' && <DealForm initial={{ company_id: company.id }} onClose={() => setForm('')} onSaved={load} />}
        </>
      )}
    </div>
  );
}
