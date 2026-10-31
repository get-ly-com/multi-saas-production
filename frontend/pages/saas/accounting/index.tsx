import { useEffect, useState } from 'react';
import APIClient from '@/lib/api-client';

const TenantId = 'accounting';

export default function Accounting() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const api = new APIClient(TenantId);

  useEffect(() => {
    loadInvoices();
  }, []);

  const loadInvoices = async () => {
    try {
      const { data } = await api.getInvoices();
      setInvoices(data);
    } catch (error) {
      console.error('Error loading invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '1000px', margin: '0 auto' }}>
      <h1>📊 Accounting App</h1>

      {loading ? (
        <p>Loading invoices...</p>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ border: '1px solid #ddd', padding: '10px' }}>Invoice #</th>
                <th style={{ border: '1px solid #ddd', padding: '10px' }}>Amount</th>
                <th style={{ border: '1px solid #ddd', padding: '10px' }}>Status</th>
                <th style={{ border: '1px solid #ddd', padding: '10px' }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: '20px', textAlign: 'center' }}>No invoices yet</td></tr>
              ) : (
                invoices.map((inv: any) => (
                  <tr key={inv.id}>
                    <td style={{ border: '1px solid #ddd', padding: '10px' }}>{inv.invoice_number}</td>
                    <td style={{ border: '1px solid #ddd', padding: '10px' }}>${inv.amount}</td>
                    <td style={{ border: '1px solid #ddd', padding: '10px' }}>{inv.status}</td>
                    <td style={{ border: '1px solid #ddd', padding: '10px' }}>{new Date(inv.created_at).toLocaleDateString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
