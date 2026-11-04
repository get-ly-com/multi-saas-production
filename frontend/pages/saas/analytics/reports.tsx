import { FormEvent, useEffect, useMemo, useState } from 'react';
import AnalyticsNav, { HBarChart, PERIODS, monthName, periodDates } from '@/components/AnalyticsNav';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, money } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';

export default function Reports() {
  return <AppShell><ReportBuilder /></AppShell>;
}

type Choice = { key: string; label: string; money?: boolean; agg?: string };
type Dataset = { key: string; label: string; dates: Choice[]; groups: Choice[]; measures: Choice[]; filters: Choice[] | null };
type Spec = {
  dataset: string; group: string; measure: string; date_field: string; filter: string;
  by_month: boolean; period: string; from: string; to: string; chart: 'bar' | 'table';
};
type Saved = { id: string; name: string; spec: Partial<Spec>; created_by: string | null; can_change: boolean };

const START: Spec = {
  dataset: 'invoices', group: 'status', measure: 'invoiced', date_field: 'invoice_date', filter: '',
  by_month: false, period: 'year', from: '', to: '', chart: 'bar'
};

function ReportBuilder() {
  const [options, setOptions] = useState<Dataset[]>([]);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [canSave, setCanSave] = useState(false);
  const [spec, setSpec] = useState<Spec>(START);
  const [openReport, setOpenReport] = useState<Saved | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState<'new' | 'update' | null>(null);

  const load = async () => {
    const data = await api.get('/api/analytics/reports');
    setOptions(data.options);
    setSaved(data.reports);
    setCanSave(data.can_save);
    return data;
  };

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  const dataset = options.find((item) => item.key === spec.dataset);
  const hasDates = !!dataset && spec.date_field !== 'none';
  const [from, to] = spec.period === 'custom' ? [spec.from, spec.to] : periodDates(spec.period);

  const run = async (chosen: Spec = spec) => {
    const [start, end] = chosen.period === 'custom' ? [chosen.from, chosen.to] : periodDates(chosen.period);
    setRunning(true);
    setNotice('');
    try {
      setResult(await api.post('/api/analytics/reports/run', { spec: { ...chosen, from: start, to: end } }));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  // Run once the choices are loaded, and again whenever they change
  useEffect(() => {
    if (dataset) run();
  }, [options, spec.dataset, spec.group, spec.measure, spec.date_field, spec.filter, spec.by_month, from, to]);

  const pickDataset = (key: string) => {
    const next = options.find((item) => item.key === key);
    if (!next) return;
    setOpenReport(null);
    setSpec({
      ...spec,
      dataset: key,
      group: next.groups[0]?.key || 'none',
      measure: next.measures[0]?.key || 'count',
      date_field: next.dates[0]?.key || 'none',
      filter: ''
    });
  };

  const open = (report: Saved) => {
    const next = { ...START, ...report.spec, filter: report.spec.filter || '', from: report.spec.from || '', to: report.spec.to || '' } as Spec;
    if (next.period === 'custom' && (!next.from || !next.to)) next.period = 'year';
    setOpenReport(report);
    setSpec(next);
  };

  const save = async (name: string) => {
    try {
      const body = { name, spec: spec.period === 'custom' ? spec : { ...spec, from: undefined, to: undefined } };
      if (saving === 'update' && openReport) {
        await api.put(`/api/analytics/reports/${openReport.id}`, body);
      } else {
        await api.post('/api/analytics/reports', body);
      }
      const data = await load();
      setOpenReport(data.reports.find((report: Saved) => report.name.toLowerCase() === name.trim().toLowerCase()) || null);
      setSaving(null);
      toast.success('Report saved', { detail: `"${name.trim()}" is in your saved reports.` });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (report: Saved) => {
    if (!window.confirm(`Delete the report "${report.name}"? This can't be undone.`)) return;
    try {
      await api.delete(`/api/analytics/reports/${report.id}`);
      if (openReport?.id === report.id) setOpenReport(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const format = (value: number | string | null) => {
    if (value === null || value === undefined) return '—';
    if (result?.money) return money(value, result.currency);
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: result?.average ? 1 : 2 });
  };

  // Month columns for the table, and month totals for the chart
  const table = useMemo(() => {
    if (!result) return null;
    const groups: any[] = result.result.groups;
    const months: string[] = result.months || [];
    const cell = new Map<string, any>(result.result.cells.map((c: any) => [`${c.label}|${c.month}`, c]));
    const monthTotals = months.map((month) => {
      const inMonth = result.result.cells.filter((c: any) => c.month === month);
      const records = inMonth.reduce((sum: number, c: any) => sum + Number(c.records), 0);
      const value = result.average
        ? (records ? inMonth.reduce((sum: number, c: any) => sum + Number(c.value) * Number(c.records), 0) / records : null)
        : inMonth.reduce((sum: number, c: any) => sum + Number(c.value), 0);
      return { month, value, records };
    });
    return { groups, months, cell, monthTotals };
  }, [result]);

  const download = () => {
    if (!result || !table) return;
    const head = [result.group, ...table.months.map((month) => monthName(month)), result.by_month ? 'Total' : result.measure, 'Records'];
    const rows = table.groups.map((group) => [
      group.label,
      ...table.months.map((month) => {
        const found = table.cell.get(`${group.label}|${month}`);
        return found ? Number(found.value) : (result.average ? '' : 0);
      }),
      group.value === null ? '' : Number(group.value),
      Number(group.records)
    ]);
    const name = (openReport?.name || `${result.dataset} by ${result.group}`).replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase();
    downloadCsv(`${name || 'report'}.csv`, [head, ...rows, ['Total', ...table.monthTotals.map((m) => m.value ?? ''), result.result.total.value ?? '', result.result.total.records]]);
  };

  if (!dataset) {
    return <div className="stack"><AnalyticsNav />{error ? <p className="error">{error}</p> : <div className="stack" aria-busy="true"><Skeleton width={180} height={28} /><div className="card"><Skeleton height={90} radius={8} /></div><SkeletonTable rows={5} columns={4} /></div>}</div>;
  }

  const set = (change: Partial<Spec>) => setSpec({ ...spec, ...change });

  return (
    <div className="stack">
      <AnalyticsNav />
      <div className="page-head">
        <div>
          <h1>{openReport ? openReport.name : 'Reports'}</h1>
          <p className="muted">Pick what to look at, how to group it and what to add up. Save a report to come back to it; everyone in the company can open saved reports.</p>
        </div>
        <div className="row-actions">
          {result && <button onClick={download}>Download CSV</button>}
          {canSave && openReport?.can_change && <button onClick={() => setSaving('update')}>Save changes</button>}
          {canSave && <button className="primary" onClick={() => setSaving('new')}>{openReport ? 'Save as new' : 'Save report'}</button>}
        </div>
      </div>

      <div className="card report-builder">
        <div className="form-grid">
          <label>Report on
            <select value={spec.dataset} onChange={(e) => pickDataset(e.target.value)}>
              {options.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label>Group by
            <select value={spec.group} onChange={(e) => set({ group: e.target.value })}>
              <option value="none">Nothing (one total)</option>
              {dataset.groups.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label>Show
            <select value={spec.measure} onChange={(e) => set({ measure: e.target.value })}>
              {dataset.measures.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label>Only
            <select value={spec.filter} onChange={(e) => set({ filter: e.target.value })}>
              <option value="">Everything</option>
              {(dataset.filters || []).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label>Date to use
            <select value={spec.date_field} onChange={(e) => set({ date_field: e.target.value })}>
              {dataset.dates.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          {hasDates && (
            <label>Period
              <select value={spec.period} onChange={(e) => {
                const value = e.target.value;
                if (value === 'custom') {
                  const [start, end] = periodDates(spec.period);
                  set({ period: value, from: spec.from || start, to: spec.to || end });
                } else {
                  set({ period: value });
                }
              }}>
                {PERIODS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
          )}
          {hasDates && spec.period === 'custom' && (
            <>
              <label>From<input type="date" value={spec.from} max={spec.to} onChange={(e) => set({ from: e.target.value })} /></label>
              <label>To<input type="date" value={spec.to} min={spec.from} onChange={(e) => set({ to: e.target.value })} /></label>
            </>
          )}
        </div>
        <div className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
          {hasDates && (
            <label className="check"><input type="checkbox" checked={spec.by_month} onChange={(e) => set({ by_month: e.target.checked })} /> Split by month</label>
          )}
          <div className="tabs" role="tablist">
            <button className={spec.chart === 'bar' ? 'active' : ''} onClick={() => set({ chart: 'bar' })}>Chart</button>
            <button className={spec.chart === 'table' ? 'active' : ''} onClick={() => set({ chart: 'table' })}>Table</button>
          </div>
          {running && <span className="muted small" role="status">Running the report…</span>}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {result && table && (
        <>
          <div className="stats">
            <div className="card">
              <div className="stat-label">{result.measure}{result.filter ? ` · ${result.filter}` : ''}</div>
              <div className="stat-value">{format(result.result.total.value)}</div>
              <div className="muted">
                {Number(result.result.total.records).toLocaleString()} {Number(result.result.total.records) === 1 ? 'record' : 'records'}
                {result.from ? ` · ${result.date_field} ${result.from} to ${result.to}` : ''}
              </div>
            </div>
          </div>

          {spec.chart === 'bar' && (
            <div className="card">
              {result.by_month ? (
                <HBarChart title={`${result.measure} by month`} series={[result.measure]} format={(value) => format(value)}
                  rows={table.monthTotals.map((m) => ({ label: monthName(m.month), values: [Number(m.value || 0)] }))} />
              ) : (
                <HBarChart title={`${result.measure} by ${result.group.toLowerCase()}`} series={[result.measure]} format={(value) => format(value)}
                  rows={table.groups.map((group) => ({ label: group.label, values: [Number(group.value || 0)] }))} />
              )}
            </div>
          )}

          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{result.group}</th>
                  {table.months.map((month) => <th key={month} className="num">{monthName(month)}</th>)}
                  <th className="num">{result.by_month ? 'Total' : result.measure}</th>
                  <th className="num">Records</th>
                </tr>
              </thead>
              <tbody>
                {table.groups.length === 0 && <tr><td colSpan={table.months.length + 3} style={{ padding: 0 }}><EmptyState compact icon="search" title="No records for these choices" line="Try a longer period or a different filter." /></td></tr>}
                {table.groups.map((group) => (
                  <tr key={group.label}>
                    <td className="wrap">{group.label}</td>
                    {table.months.map((month) => {
                      const found = table.cell.get(`${group.label}|${month}`);
                      return <td key={month} className="num">{found ? format(found.value) : (result.average ? '—' : format(0))}</td>;
                    })}
                    <td className="num"><strong>{format(group.value)}</strong></td>
                    <td className="num">{Number(group.records).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
              {table.groups.length > 1 && (
                <tfoot>
                  <tr>
                    <th>Total</th>
                    {table.monthTotals.map((m) => <th key={m.month} className="num">{format(m.value)}</th>)}
                    <th className="num">{format(result.result.total.value)}</th>
                    <th className="num">{Number(result.result.total.records).toLocaleString()}</th>
                  </tr>
                </tfoot>
              )}
            </table>
            <p className="muted">
              Amounts are in {result.currency}. The 20 biggest groups are shown; the rest are added up as "Everything else".
              {result.average && ' Averages for a whole row or month are worked out from every record in it.'}
            </p>
          </div>
        </>
      )}

      <div className="card table-wrap">
        <h2>Saved reports</h2>
        <table>
          <thead><tr><th>Name</th><th>Made by</th><th /></tr></thead>
          <tbody>
            {saved.length === 0 && <tr><td colSpan={3} style={{ padding: 0 }}><EmptyState compact icon="analytics" title="No saved reports yet" line={canSave ? 'Build a report above and save it to run it again in one click.' : 'Saved reports from your team will show here.'} /></td></tr>}
            {saved.map((report) => (
              <tr key={report.id} className={openReport?.id === report.id ? 'active' : ''}>
                <td><button className="link" onClick={() => open(report)}>{report.name}</button></td>
                <td className="muted">{report.created_by || '—'}</td>
                <td><div className="row-actions">{report.can_change && <button className="small ghost danger" onClick={() => remove(report)}>Delete</button>}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!canSave && <p className="muted">Viewers can open and run reports. Ask an owner, admin or accountant to save new ones.</p>}
      </div>

      {saving && (
        <SaveReport initial={saving === 'update' ? openReport?.name || '' : ''} title={saving === 'update' ? 'Save changes' : 'Save report'}
          onSave={save} onClose={() => setSaving(null)} />
      )}
    </div>
  );
}

function SaveReport({ initial, title, onSave, onClose }: {
  initial: string; title: string; onSave: (name: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(name);
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <label>Name<input required autoFocus maxLength={80} value={name} placeholder="Like Unpaid invoices by customer" onChange={(e) => setName(e.target.value)} /></label>
        <p className="muted">The period is saved as chosen, so "This month" always shows the current month.</p>
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}
