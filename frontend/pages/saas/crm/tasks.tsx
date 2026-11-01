import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { useTeam } from '@/components/CrmForms';
import { api, formatDate, today } from '@/lib/api';

export default function Tasks() {
  return <AppShell><TasksApp /></AppShell>;
}

function TasksApp() {
  const members = useTeam();
  const [tasks, setTasks] = useState<any[]>([]);
  const [form, setForm] = useState({ subject: '', due_on: today(), owner_id: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setTasks(await api.get('/api/crm/activities?tasks=open'));
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

  const add = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/crm/activities', { kind: 'task', ...form });
      setForm({ ...form, subject: '' });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const finish = async (task: any) => {
    try {
      await api.put(`/api/crm/activities/${task.id}/done`, { done: true });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const owner = (id: string) => members.find(({ user_id }) => user_id === id)?.email || '—';
  const sorted = [...tasks].sort((a, b) => (a.due_on || '9999').localeCompare(b.due_on || '9999'));

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head"><h1>Tasks</h1></div>

      <form className="card" onSubmit={add}>
        <div className="form-grid">
          <label>What needs doing<input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></label>
          <label>Due<input type="date" value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} /></label>
          <label>For
            <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
              <option value="">Me</option>
              {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
            </select>
          </label>
        </div>
        <div className="form-actions"><button className="primary">Add task</button></div>
      </form>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Task</th><th>Linked to</th><th>For</th><th>Due</th><th /></tr></thead>
            <tbody>
              {sorted.length === 0 && <tr><td colSpan={5} className="empty">No open tasks</td></tr>}
              {sorted.map((task) => (
                <tr key={task.id}>
                  <td className="wrap">{task.subject}{task.automation_id && <span className="muted"> · automated</span>}</td>
                  <td className="wrap">
                    {task.deal ? <Link href={`/saas/crm/deal/${task.deal.id}`}>{task.deal.title}</Link>
                      : task.lead ? <Link href={`/saas/crm/lead/${task.lead.id}`}>{task.lead.name}</Link>
                      : task.contact ? <Link href={`/saas/crm/contact/${task.contact.id}`}>{task.contact.name}</Link>
                        : task.company ? <Link href={`/saas/crm/company/${task.company.id}`}>{task.company.name}</Link> : '—'}
                  </td>
                  <td>{owner(task.owner_id)}</td>
                  <td><span className={task.due_on && task.due_on < today() ? 'late' : ''}>{formatDate(task.due_on)}</span></td>
                  <td><div className="row-actions"><button onClick={() => finish(task)}>Done</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
