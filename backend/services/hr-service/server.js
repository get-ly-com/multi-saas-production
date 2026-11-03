require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

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
    rows(hr(req).from('compensation').select('*').eq('employee_id', employeeId)),
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
  return {
    ...withManagers([found], people)[0],
    pay: pay[0] || null,
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

app.listen(PORT, () => console.log(`👔 HR Service on ${PORT}`));
