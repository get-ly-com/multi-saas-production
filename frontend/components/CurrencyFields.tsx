import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Props = {
  currency: string;
  rate: string | number;
  locked: boolean;
  onChange: (currency: string, rate: string) => void;
};

export default function CurrencyFields({ currency, rate, locked, onChange }: Props) {
  const [overview, setOverview] = useState<any>(null);

  useEffect(() => {
    api.get('/api/accounting/currencies')
      .then((data) => {
        setOverview(data);
        if (!currency) onChange(data.base, '1');
      })
      .catch(() => setOverview({ base: currency, rates: [] }));
  }, []);

  if (!overview) return null;

  const codes = Array.from(new Set([overview.base, ...overview.rates.map((row: any) => row.currency), currency].filter(Boolean)));

  const choose = (code: string) => {
    const latest = overview.rates.find((row: any) => row.currency === code);
    onChange(code, code === overview.base ? '1' : String(Number(latest?.rate || 1)));
  };

  return (
    <>
      <label>Currency
        <select disabled={locked} value={currency} onChange={(e) => choose(e.target.value)}>
          {codes.map((code) => <option key={code as string} value={code as string}>{code as string}</option>)}
        </select>
      </label>
      {currency && currency !== overview.base && (
        <label>Rate (1 {currency} in {overview.base})
          <input required disabled={locked} type="number" min="0.00000001" step="any" value={rate} onChange={(e) => onChange(currency, e.target.value)} />
        </label>
      )}
    </>
  );
}
