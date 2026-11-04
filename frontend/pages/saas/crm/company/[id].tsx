import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Billing from '@/components/Billing';
import CrmNav from '@/components/CrmNav';
import { TagChips, useTags } from '@/components/Tags';
import { CompanyForm, ContactForm, DealForm } from '@/components/CrmForms';
import { CustomValues } from '@/components/CustomFields';
import { RecordHeader, RecordSkeleton, StatTile } from '@/components/CrmRecord';
import EmptyState from '@/components/EmptyState';
import { toast } from '@/components/Toast';
import Timeline from '@/components/Timeline';
import { api, money, queryId } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import styles from '@/styles/crm.module.css';

export default function Company() {
  return <AppShell><CompanyApp /></AppShell>;
}

function CompanyApp() {
  const router = useRouter();
  const id = queryId(router.query.id);
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

  const { busy, run: once } = useSubmit();
  const remove = () => once(async () => {
    if (!window.confirm(`Delete ${company.name}? Its contacts, deals and timeline stay.`)) return;
    try {
      await api.delete(`/api/crm/companies/${id}`);
      toast.success('Company deleted', { detail: company.name });
      router.push('/saas/crm/companies');
    } catch (err: any) {
      setError(err.message);
    }
  });

  const openValue = deals.filter((deal) => deal.stage?.kind === 'open').reduce((sum, deal) => sum + Number(deal.value || 0), 0);
  const wonValue = deals.filter((deal) => deal.stage?.kind === 'won').reduce((sum, deal) => sum + Number(deal.value || 0), 0);

  return (
    <div className="stack">
      <CrmNav />
      {error && <p className="error">{error}</p>}
      {!company && !error && <RecordSkeleton />}
      {company && (
        <>
          <RecordHeader
            name={company.name}
            square
            line={company.industry}
            chips={[
              company.website && { icon: 'globe', label: company.website.replace(/^https?:\/\//, ''), href: /^https?:\/\//.test(company.website) ? company.website : `https://${company.website}`, external: true, title: 'Open the website' },
              company.phone && { icon: 'phone', label: company.phone, href: `tel:${company.phone}`, external: true, title: 'Call' },
              { icon: 'contact', label: `${contacts.length} ${contacts.length === 1 ? 'person' : 'people'}` },
              { icon: 'deal', label: `${deals.length} ${deals.length === 1 ? 'deal' : 'deals'}` }
            ]}
            tags={company.tags?.length ? <TagChips ids={company.tags} tags={tags} /> : null}
            actions={(
              <>
                <button onClick={() => setForm('contact')}>New contact</button>
                <button onClick={() => setForm('edit')}>Edit</button>
                <button disabled={busy} className="danger ghost" onClick={remove}>Delete</button>
                <button className="primary" onClick={() => setForm('deal')}>New deal</button>
              </>
            )}
          />
          <div className="stats">
            <StatTile label="Open deals" icon="deal" value={money(openValue)} note={`${deals.filter((deal) => deal.stage?.kind === 'open').length} in progress`} />
            <StatTile label="Won so far" icon="paid" tone="good" value={money(wonValue)} note={`${deals.filter((deal) => deal.stage?.kind === 'won').length} won`} />
          </div>
          {company.notes && <div className="card wrap">{company.notes}</div>}
          <CustomValues entity="company" values={company.custom} />
          <div className="card table-wrap">
            <div className={styles.cardHead}><h2>People</h2></div>
            <table>
              <tbody>
                {contacts.length === 0 && (
                  <tr><td><EmptyState compact icon="contact" title="No people yet" line="Add the people you talk to here."
                    action={{ label: 'New contact', onClick: () => setForm('contact') }} /></td></tr>
                )}
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
            <div className={styles.cardHead}><h2>Deals</h2></div>
            <table>
              <tbody>
                {deals.length === 0 && (
                  <tr><td><EmptyState compact icon="deal" title="No deals yet" line="Start a deal when there's something to sell."
                    action={{ label: 'New deal', onClick: () => setForm('deal') }} /></td></tr>
                )}
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
          {form === 'edit' && <CompanyForm initial={company} onClose={() => setForm('')} onSaved={async () => { toast.success('Saved'); await load(); }} />}
          {form === 'contact' && <ContactForm initial={{ company_id: company.id }} onClose={() => setForm('')} onSaved={async () => { toast.success('Contact added'); await load(); }} />}
          {form === 'deal' && <DealForm initial={{ company_id: company.id }} onClose={() => setForm('')} onSaved={async () => { toast.success('Deal added'); await load(); }} />}
        </>
      )}
    </div>
  );
}
