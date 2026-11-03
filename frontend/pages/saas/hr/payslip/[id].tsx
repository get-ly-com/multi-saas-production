import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { monthName } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { api, formatDate, money } from '@/lib/api';

export default function PayslipPage() {
  return <AppShell><PayslipApp /></AppShell>;
}

function PayslipApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [slip, setSlip] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (id) api.get(`/api/hr/payslips/${id}`).then(setSlip).catch((err) => setError(err.message));
  }, [id]);

  if (!slip) return <div className="stack"><HrNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  const { line, run, employee, company, currency } = slip;
  const cash = (value: any) => money(value, currency || undefined);
  const earnings = [
    { label: line.pay_type === 'hourly' ? `Hours: ${line.hours} at ${cash(line.rate)}` : 'Salary', value: line.base_pay },
    ...(Number(line.unpaid_deduction) ? [{ label: `Unpaid leave (${Number(line.unpaid_days)} days)`, value: -line.unpaid_deduction }] : []),
    ...(Number(line.additions) ? [{ label: 'Additions', value: line.additions }] : [])
  ];
  const taken = [
    { label: 'Income tax', value: line.income_tax },
    { label: 'Employee contributions', value: line.employee_contributions },
    ...(Number(line.other_deductions) ? [{ label: 'Other deductions', value: line.other_deductions }] : [])
  ];

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head no-print">
        <h1>Payslip</h1>
        <button onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      {run.status === 'draft' && <p className="error no-print">This pay run is still a draft, so the payslip may change.</p>}
      {run.status === 'void' && <p className="error">This pay run was voided.</p>}

      <div className="card">
        <div className="page-head">
          <div>
            <h2>{company}</h2>
            <p>Payslip for {monthName(run.period_start)}</p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <strong>{employee.name}</strong>
            <div className="muted">Employee {employee.employee_number}{employee.job_title ? ` · ${employee.job_title}` : ''}</div>
            <div className="muted">Paid on {formatDate(run.pay_date)}</div>
          </div>
        </div>

        <table>
          <thead><tr><th>Earnings</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {earnings.map((row) => <tr key={row.label}><td>{row.label}</td><td className="num">{cash(row.value)}</td></tr>)}
            <tr><td><strong>Gross pay</strong></td><td className="num"><strong>{cash(line.gross)}</strong></td></tr>
          </tbody>
        </table>

        <table style={{ marginTop: 16 }}>
          <thead><tr><th>Deductions</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {taken.map((row) => <tr key={row.label}><td>{row.label}</td><td className="num">{cash(row.value)}</td></tr>)}
          </tbody>
        </table>

        <div className="stats" style={{ marginTop: 16 }}>
          <div><div className="stat-label">Take-home pay</div><div className="stat-value">{cash(line.net)}</div></div>
          <div><div className="stat-label">Paid by the employer on top</div><div>{cash(line.employer_contributions)}</div></div>
        </div>
        {line.note && <p className="muted">{line.note}</p>}
      </div>
    </div>
  );
}
