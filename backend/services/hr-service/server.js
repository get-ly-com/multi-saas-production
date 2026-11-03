require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const holidays = require('./holidays');

const app = express();
const PORT = process.env.PORT || 3007;

// Queries run as the signed-in user, so database policies apply to them. Pay is only ever
// returned to owners and admins; the database decides that, not this service.
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor'];

const hr = (req) => req.db.schema('hr');
const EMPLOYEE_FIELDS = '*, department:departments(id, name)';
const LEAVE_FIELDS = '*, employee:employees(id, first_name, last_name), leave_type:leave_types(id, name, paid)';

const sendError = (res, error) => {
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === '23505') return res.status(409).json({ error: 'That name is already used' });
  if (error.code === '23503') return res.status(409).json({ error: 'This is in use. Turn it off instead of deleting it.' });
  res.status(400).json({ error: error.message });
};

const id = (value, label) => {
  if (!UUID.test(value || '')) throw new Error(`${label} not found`);
  return value;
};

const optionalId = (value, label) => (value === '' || value === null || value === undefined ? null : id(value, label));

const date = (value, message) => {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error(message);
  return value;
};

const optionalDate = (value, message) => (value === '' || value === null || value === undefined ? null : date(value, message));

const amount = (value, label, max = 1e10) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!(parsed >= 0) || parsed >= max) throw new Error(`Enter a valid ${label}`);
  return parsed;
};

const text = (value, max) => {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
};

const call = async (req, name, params) => {
  const { data, error } = await hr(req).rpc(name, { p_tenant: req.tenantId, ...params });
  if (error) throw error;
  return data ?? { success: true };
};

const callHr = (name, params, status = 200) => async (req, res) => {
  try {
    res.status(status).json(await call(req, name, params(req)));
  } catch (error) {
    sendError(res, error);
  }
};

const handle = (work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (error) {
    sendError(res, error);
  }
};

const rows = async (query) => {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

// Each person's manager comes from the same directory, so no second lookup is needed
const withManagers = (people, directory = people) => {
  const byId = new Map(directory.map((person) => [person.id, person]));
  return people.map((person) => {
    const manager = byId.get(person.manager_id);
    return { ...person, manager: manager ? { id: manager.id, first_name: manager.first_name, last_name: manager.last_name } : null };
  });
};

const employeeFields = (body) => {
  if (body.employment_type && !EMPLOYMENT_TYPES.includes(body.employment_type)) throw new Error('Choose a type of employment');
  if (body.pay_type && !['salary', 'hourly'].includes(body.pay_type)) throw new Error('Choose salary or hourly pay');
  return {
    first_name: text(body.first_name, 100).trim(),
    last_name: text(body.last_name, 100).trim(),
    email: text(body.email, 200).trim(),
    phone: text(body.phone, 50).trim(),
    job_title: text(body.job_title, 100).trim(),
    department_id: optionalId(body.department_id, 'Department'),
    manager_id: optionalId(body.manager_id, 'Manager'),
    user_id: optionalId(body.user_id, 'Team member'),
    cost_center_id: optionalId(body.cost_center_id, 'Cost center'),
    employment_type: body.employment_type || 'full_time',
    start_date: date(body.start_date, 'Enter a start date'),
    end_date: optionalDate(body.end_date, 'Enter a valid end date'),
    pay_type: body.pay_type || 'salary',
    pay_amount: amount(body.pay_amount, 'pay amount') ?? 0,
    hours_per_week: amount(body.hours_per_week, 'number of hours', 101) ?? 40,
    notes: text(body.notes, 5000)
  };
};

app.use(express.json({ limit: '256kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'hr-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

app.get('/overview', callHr('overview', () => ({})));
app.get('/me', callHr('me', () => ({})));

// People. Pay comes back only for owners and admins, because only they can read it.
app.get('/employees', handle(async (req) => {
  const [people, pay] = await Promise.all([
    rows(hr(req).from('employees').select(EMPLOYEE_FIELDS).eq('tenant_id', req.tenantId).order('first_name')),
    rows(hr(req).from('compensation').select('employee_id, pay_type, amount, hours_per_week').eq('tenant_id', req.tenantId))
  ]);
  const payFor = new Map(pay.map((row) => [row.employee_id, row]));
  return withManagers(people).map((person) => ({ ...person, pay: payFor.get(person.id) || null }));
}));

app.get('/employees/:id', handle(async (req) => {
  const employeeId = id(req.params.id, 'Employee');
  const [people, pay, leave, payslips] = await Promise.all([
    rows(hr(req).from('employees').select(EMPLOYEE_FIELDS).eq('tenant_id', req.tenantId)),
    rows(hr(req).from('compensation').select('employee_id, pay_type, amount, hours_per_week, updated_at').eq('employee_id', employeeId)),
    rows(hr(req).from('leave_requests').select(LEAVE_FIELDS).eq('employee_id', employeeId)
      .order('start_date', { ascending: false }).limit(100)),
    rows(hr(req).from('pay_lines').select('id, gross, net, run:pay_runs(id, run_number, period_start, pay_date, status)')
      .eq('employee_id', employeeId))
  ]);
  const found = people.find((person) => person.id === employeeId);
  if (!found) {
    const error = new Error('Employee not found');
    error.status = 404;
    throw error;
  }
  // Balances are only for the person, their manager, owners and admins
  const balances = await call(req, 'leave_balances', { p_employee: employeeId, p_year: new Date().getUTCFullYear() })
    .catch(() => null);
  // Private notes come only to owners and admins, even when accountants can see pay
  const notes = pay[0] ? await call(req, 'employee_notes', { p_employee: employeeId }).catch(() => null) : null;
  // Probation is only for the person, their manager, owners and admins
  const terms = await rows(hr(req).from('employment_terms').select('probation_end_date').eq('employee_id', employeeId))
    .catch(() => []);
  return {
    ...withManagers([found], people)[0],
    pay: pay[0] ? { ...pay[0], notes: typeof notes === 'string' ? notes : null } : null,
    terms: terms[0] || null,
    leave,
    balances,
    payslips: payslips.sort((a, b) => String(b.run?.period_start).localeCompare(String(a.run?.period_start)))
  };
}));

app.post('/employees', callHr('save_employee', (req) => ({ p_employee: null, p_data: employeeFields(req.body) }), 201));
app.put('/employees/:id', callHr('save_employee', (req) => ({
  p_employee: id(req.params.id, 'Employee'),
  p_data: employeeFields(req.body)
})));
app.delete('/employees/:id', callHr('delete_employee', (req) => ({ p_employee: id(req.params.id, 'Employee') })));

// Departments, leave types and holidays. Database policies let only owners and admins change them.
const simpleList = (table, columns, order) => handle((req) =>
  rows(hr(req).from(table).select(columns).eq('tenant_id', req.tenantId).order(order)));

const saveRow = (table, fields, status) => async (req, res) => {
  try {
    const values = fields(req.body);
    const query = req.params.id
      ? hr(req).from(table).update(values).eq('id', id(req.params.id, 'Item')).eq('tenant_id', req.tenantId)
      : hr(req).from(table).insert([{ tenant_id: req.tenantId, ...values }]);
    const data = await rows(query.select());
    if (!data.length) return res.status(403).json({ error: 'Only owners and admins can do that' });
    res.status(status).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteRow = (table) => async (req, res) => {
  try {
    const data = await rows(hr(req).from(table).delete().eq('id', id(req.params.id, 'Item')).eq('tenant_id', req.tenantId).select('id'));
    if (!data.length) return res.status(404).json({ error: 'Not found, or only owners and admins can do that' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
};

const departmentFields = (body) => {
  const name = text(body.name, 100).trim();
  if (!name) throw new Error('Enter a name');
  return { name };
};

const leaveTypeFields = (body) => {
  const values = {};
  if (body.name !== undefined) {
    values.name = text(body.name, 60).trim();
    if (!values.name) throw new Error('Enter a name');
  }
  if (body.days_per_year !== undefined) {
    const days = Number(body.days_per_year);
    if (!(days >= 0 && days <= 366) || Math.round(days * 2) !== days * 2) throw new Error('Days a year must be whole or half days, up to 366');
    values.days_per_year = days;
  }
  // Unused days that move to next year (0 = none). The database also checks it against the days a year.
  if (body.max_carry_over !== undefined) {
    const carry = Number(body.max_carry_over);
    if (!(carry >= 0 && carry <= 366) || Math.round(carry * 2) !== carry * 2) throw new Error('Carry over must be whole or half days');
    if (values.days_per_year !== undefined && carry > values.days_per_year) {
      throw new Error(values.days_per_year ? `Carry over can't be more than the days a year (${values.days_per_year})` : 'Leave with no limit has nothing to carry over');
    }
    values.max_carry_over = carry;
  }
  if (body.paid !== undefined) values.paid = Boolean(body.paid);
  if (body.is_active !== undefined) values.is_active = Boolean(body.is_active);
  return values;
};

const holidayFields = (body) => {
  const name = text(body.name, 100).trim();
  if (!name) throw new Error('Enter a name');
  return { holiday_date: date(body.holiday_date, 'Choose a date'), name };
};

app.get('/departments', simpleList('departments', '*', 'name'));
app.post('/departments', saveRow('departments', departmentFields, 201));
app.put('/departments/:id', saveRow('departments', departmentFields, 200));
app.delete('/departments/:id', deleteRow('departments'));

app.get('/leave-types', simpleList('leave_types', '*', 'name'));
app.post('/leave-types', saveRow('leave_types', (body) => {
  const values = leaveTypeFields(body);
  if (!values.name) throw new Error('Enter a name');
  delete values.is_active;
  return values;
}, 201));
app.put('/leave-types/:id', saveRow('leave_types', leaveTypeFields, 200));
app.delete('/leave-types/:id', deleteRow('leave_types'));

app.get('/holidays', simpleList('holidays', '*', 'holiday_date'));
app.post('/holidays', saveRow('holidays', holidayFields, 201));
app.put('/holidays/:id', saveRow('holidays', holidayFields, 200));
app.delete('/holidays/:id', deleteRow('holidays'));

// Payroll rates. Owners and admins only.
app.get('/settings', handle(async (req) => {
  const data = await rows(hr(req).from('settings').select('*').eq('tenant_id', req.tenantId));
  return data[0] || null;
}));

app.put('/settings', callHr('save_settings', (req) => ({
  p_income_tax: amount(req.body.income_tax_rate, 'income tax rate', 100.01) ?? 0,
  p_employee: amount(req.body.employee_rate, 'employee rate', 100.01) ?? 0,
  p_employer: amount(req.body.employer_rate, 'employer rate', 100.01) ?? 0
})));

// Whether accountants can see pay and run payroll. Only owners and admins can change it.
app.put('/settings/payroll-access', callHr('set_accountant_payroll', (req) => ({
  p_on: Boolean(req.body.accountants_run_payroll)
})));

// Leave. Each person sees their own requests, managers their team's, owners and admins everyone's.
app.get('/leave', handle((req) => {
  let query = hr(req).from('leave_requests').select(LEAVE_FIELDS).eq('tenant_id', req.tenantId);
  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.employee_id) query = query.eq('employee_id', id(req.query.employee_id, 'Employee'));
  return rows(query.order('start_date', { ascending: false }).limit(200));
}));

app.get('/leave/out', callHr('who_is_out', (req) => ({
  p_from: date(req.query.from, 'Choose a start and end date'),
  p_to: date(req.query.to, 'Choose a start and end date')
})));

app.get('/balances/:employeeId', callHr('leave_balances', (req) => ({
  p_employee: id(req.params.employeeId, 'Employee'),
  p_year: Number.isInteger(Number(req.query.year)) && req.query.year ? Number(req.query.year) : new Date().getUTCFullYear()
})));

app.post('/leave', callHr('request_leave', (req) => ({
  p_employee: id(req.body.employee_id, 'Employee'),
  p_type: id(req.body.leave_type_id, 'Type of leave'),
  p_start: date(req.body.start_date, 'Choose a start and end date'),
  p_end: date(req.body.end_date || req.body.start_date, 'Choose a start and end date'),
  p_half_day: Boolean(req.body.half_day),
  p_reason: text(req.body.reason, 1000).trim() || null
}), 201));

app.post('/leave/:id/decide', callHr('decide_leave', (req) => ({
  p_request: id(req.params.id, 'Request'),
  p_status: req.body.status,
  p_note: text(req.body.note, 500).trim() || null
})));

app.post('/leave/:id/cancel', callHr('cancel_leave', (req) => ({ p_request: id(req.params.id, 'Request') })));

// Payroll. Owners and admins only.
app.get('/pay-runs', handle((req) =>
  rows(hr(req).from('pay_runs').select('*').eq('tenant_id', req.tenantId).order('period_start', { ascending: false }).limit(120))));

app.get('/pay-runs/:id', handle(async (req) => {
  const runId = id(req.params.id, 'Pay run');
  const [run, lines] = await Promise.all([
    rows(hr(req).from('pay_runs').select('*').eq('tenant_id', req.tenantId).eq('id', runId)),
    rows(hr(req).from('pay_lines').select('*, employee:employees(id, employee_number, first_name, last_name, job_title)')
      .eq('run_id', runId))
  ]);
  if (!run.length) throw new Error('Pay run not found');
  const name = (line) => `${line.employee?.first_name || ''} ${line.employee?.last_name || ''}`;
  return { ...run[0], lines: lines.sort((a, b) => name(a).localeCompare(name(b))) };
}));

app.post('/pay-runs', callHr('create_pay_run', (req) => {
  if (typeof req.body.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(req.body.month)) throw new Error('Choose a month');
  return { p_month: `${req.body.month}-01`, p_pay_date: date(req.body.pay_date, 'Choose a pay date') };
}, 201));

app.post('/pay-runs/:id/recalculate', callHr('recalculate_pay_run', (req) => ({ p_run: id(req.params.id, 'Pay run') })));
app.post('/pay-runs/:id/approve', callHr('approve_pay_run', (req) => ({ p_run: id(req.params.id, 'Pay run') })));
app.post('/pay-runs/:id/pay', callHr('pay_pay_run', (req) => ({
  p_run: id(req.params.id, 'Pay run'),
  p_account: id(req.body.account_id, 'Bank or cash account'),
  p_date: date(req.body.date, 'Choose the date it was paid')
})));
app.post('/pay-runs/:id/void', callHr('void_pay_run', (req) => ({ p_run: id(req.params.id, 'Pay run') })));
app.delete('/pay-runs/:id', callHr('delete_pay_run', (req) => ({ p_run: id(req.params.id, 'Pay run') })));

// Only the fields sent are changed; taxes left out follow the company rates
app.put('/pay-lines/:id', callHr('update_pay_line', (req) => {
  const data = {};
  for (const field of ['hours', 'additions', 'income_tax', 'employee_contributions', 'other_deductions', 'employer_contributions']) {
    if (req.body[field] !== undefined && req.body[field] !== '') data[field] = amount(req.body[field], 'amount');
  }
  if (req.body.note !== undefined) data.note = text(req.body.note, 200);
  return { p_line: id(req.params.id, 'Pay line'), p_data: data };
}));
app.delete('/pay-lines/:id', callHr('remove_pay_line', (req) => ({ p_line: id(req.params.id, 'Pay line') })));

app.get('/payslips/:id', callHr('payslip', (req) => ({ p_line: id(req.params.id, 'Payslip') })));

// Tax and contributions that approved pay runs owe, and paying them from a bank or cash account
app.get('/liabilities', callHr('payroll_liabilities', () => ({})));
app.post('/liabilities/pay', callHr('pay_liabilities', (req) => {
  const paid = amount(req.body.amount, 'amount');
  if (!paid) throw new Error('Enter an amount more than zero');
  return {
    p_account: id(req.body.account_id, 'Bank or cash account'),
    p_date: date(req.body.date, 'Choose the date it was paid'),
    p_amount: paid,
    p_memo: text(req.body.memo, 200).trim() || null
  };
}, 201));

// Documents on staff records. The browser uploads the file to the private 'hr-documents' bucket,
// then records it here; owners and admins add and delete, the employee themself can read.
const DOCUMENT_KINDS = ['contract', 'id', 'certificate', 'other'];

app.get('/employees/:id/documents', handle((req) =>
  rows(hr(req).from('documents').select('id, employee_id, name, kind, storage_path, size_bytes, mime_type, created_at')
    .eq('tenant_id', req.tenantId).eq('employee_id', id(req.params.id, 'Employee'))
    .order('created_at', { ascending: false }).limit(200))));

app.post('/employees/:id/documents', callHr('add_document', (req) => {
  const name = text(req.body.name, 200).trim();
  if (!name) throw new Error('Enter a name');
  if (!DOCUMENT_KINDS.includes(req.body.kind)) throw new Error('Choose a type of document');
  if (typeof req.body.storage_path !== 'string' || !req.body.storage_path) throw new Error('Upload a file first');
  return {
    p_employee: id(req.params.id, 'Employee'),
    p_name: name,
    p_kind: req.body.kind,
    p_path: text(req.body.storage_path, 500),
    p_size: amount(req.body.size_bytes, 'file size', 5242881),
    p_mime: text(req.body.mime_type, 200) || null
  };
}, 201));

app.delete('/documents/:id', callHr('delete_document', (req) => ({ p_document: id(req.params.id, 'Document') })));

// Probation end date, and who else may run the shared clock-in kiosk. Owners and admins only.
app.put('/employees/:id/probation', callHr('set_probation', (req) => ({
  p_employee: id(req.params.id, 'Employee'),
  p_date: optionalDate(req.body.probation_end_date, 'Enter a valid probation end date')
})));

app.put('/settings/kiosk', callHr('set_kiosk_user', (req) => ({ p_user: optionalId(req.body.user_id, 'Team member') })));

// Attendance. Everyone linked to an employee clocks their own time; their manager, owners and admins
// approve it, and approved hours can go onto hourly pay.
const timeZone = (value) => (typeof value === 'string' && /^[A-Za-z_+\-/0-9]{1,64}$/.test(value) ? value : 'UTC');
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const stamp = (value, message) => {
  if (typeof value !== 'string' || !STAMP.test(value) || Number.isNaN(Date.parse(value))) throw new Error(message);
  return value;
};
const range = (req, maxDays = 62) => {
  const from = date(req.query.from, 'Choose a start and end date');
  const to = date(req.query.to, 'Choose a start and end date');
  if (to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > maxDays) throw new Error('Choose up to two months');
  return { from, to };
};

app.get('/attendance/me', callHr('my_attendance', (req) => ({ p_tz: timeZone(req.query.tz) })));
app.post('/attendance/clock', callHr('clock', (req) => ({ p_tz: timeZone(req.body.tz) })));

// The shared kiosk answers with an error message instead of failing, so wrong PINs are counted
app.post('/attendance/kiosk', handle(async (req) => {
  const number = Number(req.body.employee_number);
  if (!Number.isInteger(number) || number < 1 || number > 1e9) throw new Error('Enter your employee number');
  const pin = String(req.body.pin ?? '');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Enter your 4 to 8 number PIN');
  const result = await call(req, 'kiosk_clock', { p_number: number, p_pin: pin, p_tz: timeZone(req.body.tz) });
  if (result?.error) throw new Error(result.error);
  return result;
}));

app.post('/attendance/pin', callHr('set_kiosk_pin', (req) => {
  const pin = String(req.body.pin ?? '');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('A PIN is 4 to 8 numbers');
  return { p_employee: id(req.body.employee_id, 'Employee'), p_pin: pin };
}));

app.get('/attendance/summary', callHr('attendance_summary', (req) => {
  const { from, to } = range(req);
  return { p_from: from, p_to: to };
}));

app.get('/attendance', handle((req) => {
  const { from, to } = range(req);
  let query = hr(req).from('attendance').select('*, employee:employees(id, employee_number, first_name, last_name)')
    .eq('tenant_id', req.tenantId).gte('work_date', from).lte('work_date', to);
  if (req.query.employee_id) query = query.eq('employee_id', id(req.query.employee_id, 'Employee'));
  return rows(query.order('check_in', { ascending: false }).limit(500));
}));

const attendanceFields = (body) => ({
  employee_id: optionalId(body.employee_id, 'Employee'),
  check_in: stamp(body.check_in, 'Enter the time in'),
  check_out: body.check_out ? stamp(body.check_out, 'Enter a valid time out') : null,
  break_minutes: Math.round(amount(body.break_minutes, 'break', 601) ?? 0),
  work_date: optionalDate(body.work_date, 'Choose a valid day'),
  note: text(body.note, 300).trim(),
  tz: timeZone(body.tz)
});

app.post('/attendance', callHr('save_attendance', (req) => ({ p_entry: null, p_data: attendanceFields(req.body) }), 201));
app.put('/attendance/:id', callHr('save_attendance', (req) => ({
  p_entry: id(req.params.id, 'Time entry'),
  p_data: attendanceFields(req.body)
})));
app.delete('/attendance/:id', callHr('delete_attendance', (req) => ({ p_entry: id(req.params.id, 'Time entry') })));

app.post('/attendance/approve', callHr('approve_attendance', (req) => ({
  p_employee: id(req.body.employee_id, 'Employee'),
  p_from: date(req.body.from, 'Choose a start and end date'),
  p_to: date(req.body.to, 'Choose a start and end date')
})));

// Puts approved attendance hours on a draft pay run's hourly lines
app.post('/pay-runs/:id/attendance-hours', callHr('use_attendance_hours', (req) => ({ p_run: id(req.params.id, 'Pay run') })));

// Expense claims. Staff claim their own with a receipt in the private 'hr-receipts' bucket; their manager,
// an owner or an admin approves, which books the cost; owners, admins and accountants pay them.
const CLAIM_STATUSES = ['submitted', 'approved', 'rejected', 'cancelled', 'paid', 'void'];

app.get('/expense-categories', simpleList('expense_categories', '*', 'name'));
const categoryCall = (req) => ({
  p_category: req.params.id ? id(req.params.id, 'Category') : null,
  p_name: text(req.body.name, 60).trim(),
  p_account: optionalId(req.body.account_id, 'Account'),
  p_active: req.body.is_active === undefined ? null : Boolean(req.body.is_active)
});
app.post('/expense-categories', callHr('save_expense_category', categoryCall, 201));
app.put('/expense-categories/:id', callHr('save_expense_category', categoryCall));

app.get('/expenses', handle((req) => {
  let query = hr(req).from('expense_claims')
    .select('*, employee:employees(id, employee_number, first_name, last_name, manager_id, user_id), category:expense_categories(id, name)')
    .eq('tenant_id', req.tenantId);
  if (req.query.status) {
    if (!CLAIM_STATUSES.includes(req.query.status)) throw new Error('Choose a status');
    query = query.eq('status', req.query.status);
  }
  if (req.query.employee_id) query = query.eq('employee_id', id(req.query.employee_id, 'Employee'));
  return rows(query.order('created_at', { ascending: false }).limit(500));
}));

app.post('/expenses', callHr('submit_expense', (req) => {
  const value = amount(req.body.amount, 'amount', 1e8);
  if (!value) throw new Error('Enter an amount more than zero');
  const description = text(req.body.description, 300).trim();
  if (!description) throw new Error('Say what it was for');
  return {
    p_data: {
      employee_id: id(req.body.employee_id, 'Employee'),
      expense_date: date(req.body.expense_date, 'Choose the date you spent it'),
      category_id: id(req.body.category_id, 'Category'),
      description,
      amount: value,
      receipt_path: req.body.receipt_path ? text(req.body.receipt_path, 500) : null
    }
  };
}, 201));

app.post('/expenses/:id/decide', callHr('decide_expense', (req) => {
  if (!['approved', 'rejected'].includes(req.body.status)) throw new Error('Approve or reject the claim');
  return { p_claim: id(req.params.id, 'Claim'), p_status: req.body.status, p_note: text(req.body.note, 500).trim() || null };
}));
app.post('/expenses/:id/cancel', callHr('cancel_expense', (req) => ({ p_claim: id(req.params.id, 'Claim') })));
app.post('/expenses/:id/void', callHr('void_expense', (req) => ({ p_claim: id(req.params.id, 'Claim') })));
app.post('/expenses/pay', callHr('pay_expenses', (req) => {
  const ids = Array.isArray(req.body.claim_ids) ? [...new Set(req.body.claim_ids)] : [];
  if (!ids.length || ids.length > 100) throw new Error('Choose up to 100 claims to pay');
  return {
    p_claims: ids.map((value) => id(value, 'Claim')),
    p_account: id(req.body.account_id, 'Bank or cash account'),
    p_date: date(req.body.date, 'Choose the date it was paid')
  };
}));

// Onboarding and offboarding checklists
const CHECKLIST_KINDS = ['onboarding', 'offboarding'];
const TASK_OWNERS = ['hr', 'manager', 'employee'];

app.get('/checklists', simpleList('checklist_templates', '*', 'name'));
const checklistCall = (req) => {
  if (!CHECKLIST_KINDS.includes(req.body.kind)) throw new Error('Choose onboarding or offboarding');
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 50).map((item) => ({
    title: text(item?.title, 200).trim(),
    days: Number.isInteger(Number(item?.days)) ? Number(item.days) : 0,
    who: TASK_OWNERS.includes(item?.who) ? item.who : 'hr'
  })) : [];
  return {
    p_template: req.params.id ? id(req.params.id, 'Checklist') : null,
    p_kind: req.body.kind,
    p_name: text(req.body.name, 100).trim(),
    p_items: items
  };
};
app.post('/checklists', callHr('save_checklist_template', checklistCall, 201));
app.put('/checklists/:id', callHr('save_checklist_template', checklistCall));
app.delete('/checklists/:id', callHr('delete_checklist_template', (req) => ({ p_template: id(req.params.id, 'Checklist') })));

app.get('/employees/:id/tasks', handle((req) =>
  rows(hr(req).from('employee_tasks').select('*').eq('tenant_id', req.tenantId).eq('employee_id', id(req.params.id, 'Employee'))
    .order('position').limit(300))));
app.post('/employees/:id/checklists', callHr('start_checklist', (req) => ({
  p_employee: id(req.params.id, 'Employee'),
  p_template: id(req.body.template_id, 'Checklist')
}), 201));
app.post('/employees/:id/tasks', callHr('add_task', (req) => {
  if (!CHECKLIST_KINDS.includes(req.body.kind)) throw new Error('Choose onboarding or offboarding');
  if (req.body.who && !TASK_OWNERS.includes(req.body.who)) throw new Error('Choose who does this step');
  return {
    p_employee: id(req.params.id, 'Employee'),
    p_kind: req.body.kind,
    p_title: text(req.body.title, 200).trim(),
    p_due: optionalDate(req.body.due_date, 'Choose a valid due date'),
    p_who: req.body.who || 'hr'
  };
}, 201));
app.put('/tasks/:id', callHr('set_task_done', (req) => ({ p_task: id(req.params.id, 'Step'), p_done: Boolean(req.body.done) })));
app.delete('/tasks/:id', callHr('delete_task', (req) => ({ p_task: id(req.params.id, 'Step') })));

// Starts, last days, probation ends and checklist steps coming up
app.get('/upcoming', callHr('upcoming_dates', (req) => ({
  p_days: Math.min(Math.max(parseInt(req.query.days, 10) || 60, 1), 180)
})));

// Public holidays worked out from each country's rules, added to the company's holidays
app.get('/public-holidays/countries', (req, res) => res.json(holidays.countries()));
app.get('/public-holidays', handle(async (req) => {
  const list = holidays.holidaysFor(String(req.query.country || ''), Number(req.query.year));
  if (!list) throw new Error('Choose a country and a year between 2000 and 2100');
  return list;
}));
app.post('/public-holidays/import', callHr('import_holidays', (req) => {
  const list = holidays.holidaysFor(String(req.body.country || ''), Number(req.body.year));
  if (!list) throw new Error('Choose a country and a year between 2000 and 2100');
  const skip = new Set(Array.isArray(req.body.skip) ? req.body.skip.map(String) : []);
  const chosen = list.filter((day) => !skip.has(day.date));
  if (!chosen.length) throw new Error('Choose at least one holiday');
  return { p_days: chosen };
}, 201));

app.listen(PORT, () => console.log(`👔 HR Service on ${PORT}`));
