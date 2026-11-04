import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { api, money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export const fullName = (person: any) => (person ? `${person.first_name} ${person.last_name || ''}`.trim() : '');

export const EMPLOYMENT_TYPES: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contractor: 'Contractor' };

export const monthName = (date: string) =>
  new Date(`${date.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

export const leaveDates = (row: any) =>
  row.start_date === row.end_date
    ? `${row.start_date}${row.half_day ? ' (half day)' : ''}`
    : `${row.start_date} to ${row.end_date}`;

export const blankEmployee = {
  first_name: '', last_name: '', email: '', phone: '', job_title: '', department_id: '', manager_id: '', user_id: '',
  employment_type: 'full_time', start_date: '', end_date: '', cost_center_id: '', pay_type: 'salary', pay_amount: '',
  hours_per_week: '40', notes: ''
};

// Fills the form from a saved employee and their pay
export const employeeForm = (person: any) => ({
  ...blankEmployee,
  ...Object.fromEntries(Object.keys(blankEmployee).map((key) => [key, person[key] ?? ''])),
  id: person.id,
  pay_type: person.pay?.pay_type || 'salary',
  pay_amount: person.pay?.amount ?? '',
  hours_per_week: person.pay?.hours_per_week ?? '40',
  notes: person.pay?.notes || ''
});

export function EmployeeForm({ initial, people, onClose, onSaved }: {
  initial: any; people: any[]; onClose: () => void; onSaved: (saved: any) => void;
}) {
  const [form, setForm] = useState<any>(initial);
  const [departments, setDepartments] = useState<any[]>([]);
  const [costCenters, setCostCenters] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  useEffect(() => {
    api.get('/api/hr/departments').then(setDepartments).catch(() => setDepartments([]));
    api.get('/api/accounting/cost-centers').then(setCostCenters).catch(() => setCostCenters([]));
    api.get('/api/team').then((team) => setMembers(team.members || [])).catch(() => setMembers([]));
  }, []);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { id, ...body } = form;
      try {
        const saved = id ? await api.put(`/api/hr/employees/${id}`, body) : await api.post('/api/hr/employees', body);
        await onSaved(saved);
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const monthly = form.pay_type === 'salary'
    ? Number(form.pay_amount) / 12
    : Number(form.pay_amount) * Number(form.hours_per_week) * 52 / 12;

  return (
    <Modal title={form.id ? `Edit ${fullName(initial)}` : 'New employee'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>First name<input required maxLength={100} value={form.first_name} onChange={(e) => set('first_name', e.target.value)} /></label>
          <label>Last name<input maxLength={100} value={form.last_name} onChange={(e) => set('last_name', e.target.value)} /></label>
          <label>Job title<input maxLength={100} value={form.job_title} onChange={(e) => set('job_title', e.target.value)} /></label>
          <label>Work email<input type="email" maxLength={200} value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
          <label>Phone<input maxLength={50} value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
          <label>Department
            <select value={form.department_id} onChange={(e) => set('department_id', e.target.value)}>
              <option value="">None</option>
              {departments.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <label>Manager
            <select value={form.manager_id} onChange={(e) => set('manager_id', e.target.value)}>
              <option value="">None</option>
              {people.filter((row) => row.id !== form.id).map((row) => <option key={row.id} value={row.id}>{fullName(row)}</option>)}
            </select>
          </label>
          <label>Type
            <select value={form.employment_type} onChange={(e) => set('employment_type', e.target.value)}>
              {Object.entries(EMPLOYMENT_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Start date<input type="date" required value={form.start_date} onChange={(e) => set('start_date', e.target.value)} /></label>
          <label>End date<input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} /></label>
          <label>Sign-in account
            <select value={form.user_id} onChange={(e) => set('user_id', e.target.value)}>
              <option value="">Not linked</option>
              {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
            </select>
          </label>
          {costCenters.length > 0 && (
            <label>Cost center
              <select value={form.cost_center_id} onChange={(e) => set('cost_center_id', e.target.value)}>
                <option value="">None</option>
                {costCenters.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <p className="muted">Link a sign-in account so this person can ask for leave and see their own payslips.</p>

        {form.employment_type !== 'contractor' && (
          <>
            <h3>Pay</h3>
            <div className="form-grid">
              <label>Paid
                <select value={form.pay_type} onChange={(e) => set('pay_type', e.target.value)}>
                  <option value="salary">Yearly salary</option>
                  <option value="hourly">By the hour</option>
                </select>
              </label>
              <label>{form.pay_type === 'salary' ? 'Salary a year' : 'Rate an hour'}
                <input type="number" min="0" step="0.01" value={form.pay_amount} onChange={(e) => set('pay_amount', e.target.value)} />
              </label>
              <label>Usual hours a week<input type="number" min="1" max="100" step="0.5" value={form.hours_per_week} onChange={(e) => set('hours_per_week', e.target.value)} /></label>
            </div>
            {monthly > 0 && <p className="muted">About {money(monthly)} a month before tax. Only owners and admins can see pay.</p>}
          </>
        )}
        {form.employment_type === 'contractor' && <p className="muted">Contractors aren't on payroll. Pay them with a bill in Accounting.</p>}

        <label style={{ marginTop: 12 }}>Private notes<textarea rows={3} maxLength={5000} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        <p className="muted">Only owners and admins can see these notes.</p>

        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

export function LeaveForm({ people, employeeId, onClose, onSaved }: {
  people: any[]; employeeId?: string; onClose: () => void; onSaved: () => void;
}) {
  const [types, setTypes] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ employee_id: employeeId || people[0]?.id || '', leave_type_id: '', start_date: '', end_date: '', half_day: false, reason: '' });
  const [balances, setBalances] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const set = (field: string, value: any) => setForm({ ...form, [field]: value });

  useEffect(() => {
    api.get('/api/hr/leave-types').then((rows) => {
      const active = rows.filter((row: any) => row.is_active);
      setTypes(active);
      setForm((current: any) => ({ ...current, leave_type_id: current.leave_type_id || active[0]?.id || '' }));
    }).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!form.employee_id) return setBalances(null);
    const year = (form.start_date || new Date().toISOString()).slice(0, 4);
    api.get(`/api/hr/balances/${form.employee_id}?year=${year}`).then(setBalances).catch(() => setBalances(null));
  }, [form.employee_id, form.start_date.slice(0, 4)]);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/hr/leave', { ...form, end_date: form.half_day ? form.start_date : form.end_date || form.start_date });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const balance = balances?.find((row) => row.leave_type_id === form.leave_type_id);

  return (
    <Modal title="Request leave" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          {people.length > 1 || !employeeId ? (
            <label>Person
              <select required value={form.employee_id} onChange={(e) => set('employee_id', e.target.value)}>
                {people.map((row) => <option key={row.id} value={row.id}>{fullName(row)}</option>)}
              </select>
            </label>
          ) : null}
          <label>Type
            <select required value={form.leave_type_id} onChange={(e) => set('leave_type_id', e.target.value)}>
              {types.map((row) => <option key={row.id} value={row.id}>{row.name}{row.paid ? '' : ' (unpaid)'}</option>)}
            </select>
          </label>
          <label>From<input type="date" required value={form.start_date} onChange={(e) => set('start_date', e.target.value)} /></label>
          {!form.half_day && <label>To<input type="date" min={form.start_date} value={form.end_date} onChange={(e) => set('end_date', e.target.value)} /></label>}
        </div>
        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={form.half_day} onChange={(e) => set('half_day', e.target.checked)} /> Half a day
        </label>
        <label style={{ marginTop: 12 }}>Reason<textarea rows={2} maxLength={1000} value={form.reason} onChange={(e) => set('reason', e.target.value)} /></label>
        {balance && (
          <p className="muted">
            {balance.limited ? `${balance.left} of ${balance.allowance} days${Number(balance.carried_over) > 0 ? ` + ${balance.carried_over} carried over` : ''} left this year` : `${balance.taken} days taken this year`}
            {Number(balance.pending) > 0 ? `, ${balance.pending} waiting for approval` : ''}. Weekends and company holidays aren't counted.
          </p>
        )}
        <p className="muted">The reason is seen only by this person, their manager, owners and admins.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy || !types.length}>Send request</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
