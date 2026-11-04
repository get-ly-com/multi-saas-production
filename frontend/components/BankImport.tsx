import { ChangeEvent, useMemo, useState } from 'react';
import Modal from '@/components/Modal';
import { api, money } from '@/lib/api';
import { DATE_FORMATS, guessDateFormat, parseCsv, parseStatementAmount, parseStatementDate } from '@/lib/csv';
import useSubmit from '@/lib/useSubmit';

type Props = { accountId: string; onClose: () => void; onSaved: (message: string) => void };

const guess = (headers: string[], words: string[]) =>
  String(Math.max(headers.findIndex((header) => words.some((word) => header.toLowerCase().includes(word))), 0));

export default function BankImport({ accountId, onClose, onSaved }: Props) {
  const [rows, setRows] = useState<string[][]>([]);
  const [map, setMap] = useState({ date: '0', description: '0', amount: '0', out: '' });
  const [format, setFormat] = useState(DATE_FORMATS[0]);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setMap({ ...map, [field]: value });

  const headers = rows[0] || [];

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) return setError('That file has no statement lines');

    const titles = parsed[0];
    const dateColumn = guess(titles, ['date']);
    setRows(parsed);
    setError('');
    setFormat(guessDateFormat(parsed.slice(1).map((row) => row[Number(dateColumn)] || '')));
    setMap({
      date: dateColumn,
      description: guess(titles, ['desc', 'narrat', 'particular', 'detail', 'memo']),
      amount: guess(titles, ['amount', 'credit', 'deposit', 'money in']),
      out: titles.findIndex((title) => /debit|withdraw|money out/i.test(title)) >= 0
        ? String(titles.findIndex((title) => /debit|withdraw|money out/i.test(title)))
        : ''
    });
  };

  const { lines, bad } = useMemo(() => {
    const good: any[] = [];
    let failed = 0;

    rows.slice(1).forEach((row) => {
      const line_date = parseStatementDate(row[Number(map.date)] || '', format);
      const description = (row[Number(map.description)] || '').trim();
      const moneyIn = parseStatementAmount(row[Number(map.amount)] || '');
      const moneyOut = map.out ? parseStatementAmount(row[Number(map.out)] || '') : null;
      const amount = (moneyIn || 0) - Math.abs(moneyOut || 0);

      if (line_date && description && (moneyIn !== null || moneyOut !== null)) {
        good.push({ line_date, description, amount });
      } else {
        failed += 1;
      }
    });

    return { lines: good, bad: failed };
  }, [rows, map, format]);

  const { busy, run: once } = useSubmit();
  const importLines = () => once(async () => {
    try {
      const result = await api.post('/api/accounting/bank/import', { account_id: accountId, lines });
      await onSaved(`Imported ${result.imported} lines, skipped ${result.skipped} already imported or empty`);
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  });

  const columnSelect = (field: 'date' | 'description' | 'amount' | 'out', label: string, optional = false) => (
    <label>{label}
      <select value={map[field]} onChange={(e) => set(field, e.target.value)}>
        {optional && <option value="">None</option>}
        {headers.map((header, index) => <option key={index} value={index}>{header}</option>)}
      </select>
    </label>
  );

  return (
    <Modal title="Import a bank statement" onClose={onClose}>
      <p className="muted">Download a CSV statement from your bank's website and choose it here.</p>
      <label>Statement file<input type="file" accept=".csv,text/csv" onChange={readFile} /></label>

      {rows.length > 0 && (
        <>
          <div className="form-grid" style={{ marginTop: 12 }}>
            {columnSelect('date', 'Date column')}
            {columnSelect('description', 'Description column')}
            {columnSelect('amount', map.out ? 'Money in column' : 'Amount column')}
            {columnSelect('out', 'Money out column', true)}
            <label>Date format
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                {DATE_FORMATS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>

          <p>{lines.length} lines ready{bad > 0 && `, ${bad} can't be read`}</p>
          {lines.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {lines.slice(0, 5).map((line, index) => (
                    <tr key={index}><td>{line.line_date}</td><td className="wrap">{line.description}</td><td className="num">{money(line.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button className="primary" disabled={lines.length === 0} onClick={importLines}>Import {lines.length || ''} lines</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
