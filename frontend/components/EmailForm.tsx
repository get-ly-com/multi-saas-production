import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';

type Links = { contact_id?: string; deal_id?: string; lead_id?: string };

export const MERGE_FIELDS = [
  { tag: '{{first_name}}', name: 'First name' },
  { tag: '{{name}}', name: 'Full name' },
  { tag: '{{company}}', name: 'Company' },
  { tag: '{{deal}}', name: 'Deal' }
];

// Fills a template's tags from the record; tags with nothing to fill are left blank
const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{\{\s*(first_name|name|company|deal)\s*\}\}/g, (_, tag) => values[tag] || '');

export default function EmailForm({ links, onClose }: { links: Links; onClose: () => void }) {
  const [status, setStatus] = useState<any>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [recipient, setRecipient] = useState<{ email: string; values: Record<string, string> } | null>(null);
  const [form, setForm] = useState({ subject: '', body: '' });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/crm/emails/status').then(setStatus).catch((err) => setError(err.message));
    api.get('/api/crm/email-templates').then(setTemplates).catch(() => setTemplates([]));

    // Who the email goes to: the contact, the lead, or the deal's contact
    const find = async () => {
      if (links.lead_id) {
        const lead = await api.get(`/api/crm/leads/${links.lead_id}`);
        return { email: lead.email, values: { name: lead.name, company: lead.company_name } };
      }
      const deal = links.deal_id ? await api.get(`/api/crm/deals/${links.deal_id}`) : null;
      const contactId = links.contact_id || deal?.contact?.id;
      const contact = contactId ? await api.get(`/api/crm/contacts/${contactId}`) : null;
      return {
        email: contact?.email || '',
        values: { name: contact?.name, company: deal?.company?.name || contact?.company?.name, deal: deal?.title }
      };
    };
    find()
      .then(({ email, values }) => setRecipient({
        email: email || '',
        values: { ...values, first_name: (values.name || '').trim().split(/\s+/)[0] || '' } as Record<string, string>
      }))
      .catch((err) => setError(err.message));
  }, []);

  const applyTemplate = (id: string) => {
    const template = templates.find((row) => row.id === id);
    if (template && recipient) setForm({ subject: fill(template.subject, recipient.values), body: fill(template.body, recipient.values) });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    try {
      await api.post('/api/crm/emails', { ...links, to: recipient?.email, ...form });
      onClose();
    } catch (err: any) {
      setError(err.message);
      setSending(false);
    }
  };

  const ready = status?.configured && recipient?.email && Number(status.left_today) > 0;

  return (
    <Modal title="Send email">
      <form onSubmit={submit}>
        {status && !status.configured && (
          <p className="error">Email sending isn't set up yet. You can still log an email you sent elsewhere on the timeline.</p>
        )}
        {recipient && !recipient.email && (
          <p className="error">{links.deal_id && !links.contact_id ? 'Link a contact with an email address to this deal first.' : 'Add an email address to this record first.'}</p>
        )}
        {status?.configured && Number(status.left_today) <= 0 && <p className="error">Your company has reached today's email limit.</p>}

        <p className="muted">
          To <strong>{recipient?.email || '…'}</strong>. It's sent from your company's name and replies come to your own email address.
          {status?.configured && ` ${status.today} of ${status.day_limit} sent today.`}
        </p>

        <div className="form-grid">
          {templates.length > 0 && (
            <label>Template
              <select defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">None</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
            </label>
          )}
          <label>Subject<input required maxLength={200} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></label>
        </div>
        <label style={{ marginTop: 12 }}>Message<textarea required rows={10} maxLength={20000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
        <p className="muted">Sent as plain text. It's logged on the timeline once it's sent.</p>

        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={!ready || sending}>{sending ? 'Sending…' : 'Send'}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
