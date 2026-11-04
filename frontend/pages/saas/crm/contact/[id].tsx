import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Billing from '@/components/Billing';
import CrmNav from '@/components/CrmNav';
import { TagChips, useTags } from '@/components/Tags';
import { ContactForm, DealForm } from '@/components/CrmForms';
import { CustomValues } from '@/components/CustomFields';
import { CrmIcon, RecordHeader, RecordSkeleton } from '@/components/CrmRecord';
import EmptyState from '@/components/EmptyState';
import { toast } from '@/components/Toast';
import Timeline from '@/components/Timeline';
import { api, money, queryId } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import { whatsappLink, whatsappNumber } from '@/lib/whatsapp';
import styles from '@/styles/crm.module.css';

export default function Contact() {
  return <AppShell><ContactApp /></AppShell>;
}

function ContactApp() {
  const router = useRouter();
  const id = queryId(router.query.id);
  const [contact, setContact] = useState<any>(null);
  const [deals, setDeals] = useState<any[]>([]);
  const [error, setError] = useState('');
  const tags = useTags();
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

  const { busy, run: once } = useSubmit();
  const remove = () => once(async () => {
    if (!window.confirm(`Delete ${contact.name}? Their deals and timeline stay.`)) return;
    try {
      await api.delete(`/api/crm/contacts/${id}`);
      toast.success('Contact deleted', { detail: contact.name });
      router.push('/saas/crm/contacts');
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <CrmNav />
      {error && <p className="error">{error}</p>}
      {!contact && !error && <RecordSkeleton />}
      {contact && (
        <>
          <RecordHeader
            name={contact.name}
            line={(contact.job_title || contact.company) && (
              <>
                {contact.job_title}
                {contact.job_title && contact.company && ' at '}
                {contact.company && <Link href={`/saas/crm/company/${contact.company.id}`}>{contact.company.name}</Link>}
              </>
            )}
            chips={[
              contact.email && { icon: 'mail', label: contact.email, href: `mailto:${contact.email}`, external: true, title: 'Write an email' },
              contact.phone && { icon: 'phone', label: contact.phone, href: `tel:${contact.phone}`, external: true, title: 'Call' },
              contact.source && { icon: 'globe', label: contact.source, title: 'Source' },
              contact.campaign && { icon: 'target', label: contact.campaign, title: 'Campaign' },
              deals.length > 0 && { icon: 'deal', label: `${deals.length} ${deals.length === 1 ? 'deal' : 'deals'}` }
            ]}
            tags={contact.tags?.length ? <TagChips ids={contact.tags} tags={tags} /> : null}
            actions={(
              <>
                {whatsappNumber(contact.phone) && (
                  <a className="button" href={whatsappLink(contact.phone)} target="_blank" rel="noopener noreferrer"
                    title="Opens a WhatsApp chat with this number"><CrmIcon name="whatsapp" />Send on WhatsApp</a>
                )}
                <button onClick={() => setEditing(true)}>Edit</button>
                <button disabled={busy} className="danger ghost" onClick={remove}>Delete</button>
                <button className="primary" onClick={() => setAdding(true)}>New deal</button>
              </>
            )}
          />
          {contact.notes && <div className="card wrap">{contact.notes}</div>}
          <CustomValues entity="contact" values={contact.custom} />
          <div className="card table-wrap">
            <div className={styles.cardHead}><h2>Deals</h2></div>
            <table>
              <tbody>
                {deals.length === 0 && (
                  <tr><td><EmptyState compact icon="deal" title="No deals yet" line={`When ${contact.name.split(' ')[0]} wants to buy, start a deal to track it.`}
                    action={{ label: 'New deal', onClick: () => setAdding(true) }} /></td></tr>
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
          <Billing query={`contact_id=${contact.id}`} />
          <Timeline links={{ contact_id: contact.id }} />
          {editing && <ContactForm initial={contact} onClose={() => setEditing(false)} onSaved={async () => { toast.success('Saved'); await load(); }} />}
          {adding && <DealForm initial={{ contact_id: contact.id }} onClose={() => setAdding(false)} onSaved={async () => { toast.success('Deal added'); await load(); }} />}
        </>
      )}
    </div>
  );
}
