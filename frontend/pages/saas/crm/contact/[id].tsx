import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Billing from '@/components/Billing';
import CrmNav from '@/components/CrmNav';
import { ContactForm, DealForm } from '@/components/CrmForms';
import { CustomValues } from '@/components/CustomFields';
import Timeline from '@/components/Timeline';
import { api, money } from '@/lib/api';

export default function Contact() {
  return <AppShell><ContactApp /></AppShell>;
}

function ContactApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [contact, setContact] = useState<any>(null);
  const [deals, setDeals] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const [row, dealRows] = await Promise.all([api.get(`/api/crm/contacts/${id}`), api.get(`/api/crm/deals?contact_id=${id}`)]);
      setContact(row);
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
    if (!window.confirm(`Delete ${contact.name}? Their deals and timeline stay.`)) return;
    try {
      await api.delete(`/api/crm/contacts/${id}`);
      router.push('/saas/crm/contacts');
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <CrmNav />
      {error && <p className="error">{error}</p>}
      {contact && (
        <>
          <div className="page-head">
            <div>
              <h1>{contact.name}</h1>
              <p className="muted">
                {[contact.job_title, contact.email, contact.phone, contact.source].filter(Boolean).join(' · ')}
                {contact.company && <> · <Link href={`/saas/crm/company/${contact.company.id}`}>{contact.company.name}</Link></>}
              </p>
            </div>
            <div className="row-actions">
              <button onClick={() => setAdding(true)}>New deal</button>
              <button onClick={() => setEditing(true)}>Edit</button>
              <button className="danger" onClick={remove}>Delete</button>
            </div>
          </div>
          {contact.notes && <div className="card wrap">{contact.notes}</div>}
          <CustomValues entity="contact" values={contact.custom} />
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
          <Billing query={`contact_id=${contact.id}`} />
          <Timeline links={{ contact_id: contact.id }} />
          {editing && <ContactForm initial={contact} onClose={() => setEditing(false)} onSaved={load} />}
          {adding && <DealForm initial={{ contact_id: contact.id }} onClose={() => setAdding(false)} onSaved={load} />}
        </>
      )}
    </div>
  );
}
