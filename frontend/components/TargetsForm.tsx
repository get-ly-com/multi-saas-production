import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';
import { monthName } from '@/lib/forecast';

// Keyed by user id, with '' for the whole company
type Amounts = Record<string, string>;

export default function TargetsForm({ month: firstMonth, members, onClose, onSaved }: { month: string; members: any[]; onClose: () => void; onSaved: () => void }) {
  const [month, setMonth] = useState(firstMonth);
  const [amounts, setAmounts] = useState<Amounts>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sellers = members.filter(({ role }) => role !== 'viewer');

  useEffect(() => {
    if (!month) return;
    setLoading(true);
    api.get(`/api/crm/targets?month=${month}`)
      .then((rows: any[]) => {
        setAmounts(Object.fromEntries(rows.map((row) => [row.user_id || '', String(row.amount)])));
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [month]);

  const set = (person: string, value: string) => setAmounts({ ...amounts, [person]: value });
  const peopleTotal = sellers.reduce((sum, { user_id }) => sum + Number(amounts[user_id] || 0), 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/crm/targets', {
        month,
        // Saving replaces the month, so a target for someone who left the team goes
        targets: ['', ...sellers.map(({ user_id }) => user_id)].map((user_id) => ({ user_id, amount: amounts[user_id] ?? '' }))
      });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title="Sales targets">
      <form onSubmit={submit}>
        <p className="muted">Targets are the value of deals to win in a month. Leave the company target blank to add up the people's targets.</p>
        <div className="form-grid">
          <label>Month<input required type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        </div>
        {!loading && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>{month ? monthName(month) : ''}</th><th className="num">Target</th></tr></thead>
              <tbody>
                <tr>
                  <td>Whole company</td>
                  <td className="num">
                    <input aria-label="Company target" type="number" min="0" step="0.01" placeholder={peopleTotal ? String(peopleTotal) : 'None'} value={amounts[''] ?? ''} onChange={(e) => set('', e.target.value)} />
                  </td>
                </tr>
                {sellers.map((member) => (
                  <tr key={member.user_id}>
                    <td className="wrap">{member.email}</td>
                    <td className="num">
                      <input aria-label={`Target for ${member.email}`} type="number" min="0" step="0.01" placeholder="None" value={amounts[member.user_id] ?? ''} onChange={(e) => set(member.user_id, e.target.value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={loading}>Save targets</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
