import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { PayStepper, monthName } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { api, formatDate, money, queryId } from '@/lib/api';
import styles from '@/styles/hr.module.css';

export default function PayslipPage() {
  return <AppShell><PayslipApp /></AppShell>;
}

function PayslipApp() {
  const router = useRouter();
  const id = queryId(router.query.id);
  const [slip, setSlip] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (id) api.get(`/api/hr/payslips/${id}`).then(setSlip).catch((err) => setError(err.message));
  }, [id]);

  if (!slip) {
    return (
      <div className="stack">
        <HrNav />
        {error ? <p className="error">{error}</p> : (
          <div className={`card ${styles.slip}`} role="status" aria-label="Loading">
            <div className={styles.slipHead}><Skeleton width={200} height={22} /><Skeleton width={160} height={60} /></div>
            <div className={styles.slipBody}>
              <div className={styles.slipCol}><Skeleton height={14} /><Skeleton height={14} style={{ marginTop: 10 }} /></div>
              <div className={styles.slipCol}><Skeleton height={14} /><Skeleton height={14} style={{ marginTop: 10 }} /></div>
            </div>
          </div>
        )}
      </div>
    );
  }

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
  const takenTotal = taken.reduce((sum, row) => sum + Number(row.value || 0), 0);

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head no-print">
        <div>
          <h1>Payslip</h1>
          <p className="muted">{employee.name}, {monthName(run.period_start)}</p>
        </div>
        <div className="row-actions">
          {run.status !== 'void' && <PayStepper status={run.status} />}
          <button className="always" onClick={() => window.print()}><Icon name="import" size={15} /> Print or save as PDF</button>
        </div>
      </div>
      {run.status === 'draft' && <p className="muted no-print"><span className="badge pending">Draft</span> This pay run is still a draft, so the payslip may change.</p>}
      {run.status === 'void' && <p className="error">This pay run was voided.</p>}

      <article className={`card ${styles.slip}`} aria-label="Payslip">
        <header className={styles.slipHead}>
          <div>
            <div className={styles.slipTitle}>Payslip</div>
            <p className={styles.slipCompany}>{company}</p>
            <div className="muted">{monthName(run.period_start)}</div>
          </div>
          <dl className={styles.slipMeta}>
            <dt>Employee</dt><dd>{employee.name}</dd>
            <dt>Number</dt><dd>{employee.employee_number}</dd>
            {employee.job_title && <><dt>Job</dt><dd>{employee.job_title}</dd></>}
            <dt>Pay date</dt><dd>{formatDate(run.pay_date)}</dd>
            <dt>Period</dt><dd>{formatDate(run.period_start)}{run.period_end ? ` to ${formatDate(run.period_end)}` : ''}</dd>
          </dl>
        </header>

        <div className={styles.slipBody}>
          <section className={styles.slipCol}>
            <h3>Earnings</h3>
            {earnings.map((row) => (
              <div key={row.label} className={styles.slipLine}><span>{row.label}</span><span>{cash(row.value)}</span></div>
            ))}
            <div className={`${styles.slipLine} ${styles.slipTotal}`}><span>Gross pay</span><span>{cash(line.gross)}</span></div>
          </section>
          <section className={styles.slipCol}>
            <h3>Deductions</h3>
            {taken.map((row) => (
              <div key={row.label} className={styles.slipLine}><span>{row.label}</span><span>{cash(row.value)}</span></div>
            ))}
            <div className={`${styles.slipLine} ${styles.slipTotal}`}><span>Total deductions</span><span>{cash(takenTotal)}</span></div>
          </section>
        </div>

        <div className={styles.slipNet}>
          <div>
            <div className={styles.slipTitle}>Take-home pay</div>
            <div className="muted small">Gross pay less deductions</div>
          </div>
          <strong>{cash(line.net)}</strong>
        </div>

        <footer className={styles.slipFoot}>
          Paid by the employer on top: {cash(line.employer_contributions)} in contributions.
          {line.note && <div style={{ marginTop: 6, color: 'var(--text-2)' }}>{line.note}</div>}
        </footer>
      </article>
    </div>
  );
}
