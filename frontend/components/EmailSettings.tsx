import { FormEvent, useEffect, useState } from 'react';
import { MERGE_FIELDS } from '@/components/EmailForm';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankTemplate = { name: '', subject: '', body: '' };

export default function EmailSettings() {
  const [status, setStatus] = useState<any>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [state, rows] = await Promise.all([api.get('/api/crm/emails/status'), api.get('/api/crm/email-templates')]);
      setStatus(state);
      setTemplates(rows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run: once } = useSubmit();
  const remove = (template: any) => once(async () => {
    if (!window.confirm(`Delete the template ${template.name}?`)) return;
    try {
      await api.delete(`/api/crm/email-templates/${template.id}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="card table-wrap">
      <div className="page-head">
        <h2>Email</h2>
        <button onClick={() => setEditing(blankTemplate)}>New template</button>
      </div>
      {status && (
        <p className="muted">
          {status.configured
            ? `Sending is on. Your company has sent ${status.today} of ${status.day_limit} today and ${status.month} of ${status.month_limit} this month.`
            : "Sending isn't set up yet, so the Send email button can't send. Emails can still be logged on the timeline."}
          {' '}Emails go from your company's name, and replies come to the sender's own address.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Template</th><th>Subject</th><th /></tr></thead>
        <tbody>
          {templates.length === 0 && <tr><td colSpan={3} className="empty">No templates yet</td></tr>}
          {templates.map((template) => (
            <tr key={template.id}>
              <td className="wrap">{template.name}</td>
              <td className="wrap">{template.subject}</td>
              <td>
                <div className="row-actions">
                  <button onClick={() => setEditing(template)}>Edit</button>
                  <button disabled={busy} className="danger" onClick={() => remove(template)}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <TemplateForm initial={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function TemplateForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { name, subject, body } = form;
      try {
        if (form.id) await api.put(`/api/crm/email-templates/${form.id}`, { name, subject, body });
        else await api.post('/api/crm/email-templates', { name, subject, body });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? `Edit ${initial.name}` : 'New email template'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required maxLength={100} value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Subject<input required maxLength={200} value={form.subject} onChange={(e) => set('subject', e.target.value)} /></label>
        </div>
        <label style={{ marginTop: 12 }}>Message<textarea required rows={10} maxLength={20000} value={form.body} onChange={(e) => set('body', e.target.value)} /></label>
        <p className="muted">Fill in from the record: {MERGE_FIELDS.map(({ tag, name }) => `${tag} ${name.toLowerCase()}`).join(', ')}.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
