import { useEffect, useState } from 'react';
import APIClient from '@/lib/api-client';

export default function CRM() {
  const [contacts, setContacts] = useState([]);
  const api = new APIClient('crm');

  useEffect(() => {
    api.getContacts().then(({ data }) => setContacts(data)).catch(console.error);
  }, []);

  return (
    <div style={{ padding: '20px', maxWidth: '1000px', margin: '0 auto' }}>
      <h1>👥 CRM App</h1>
      <p>Total Contacts: {contacts.length}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ border: '1px solid #ddd', padding: '10px' }}>Name</th>
            <th style={{ border: '1px solid #ddd', padding: '10px' }}>Email</th>
            <th style={{ border: '1px solid #ddd', padding: '10px' }}>Phone</th>
          </tr>
        </thead>
        <tbody>
          {contacts.length === 0 ? (
            <tr><td colSpan={3} style={{ padding: '20px', textAlign: 'center' }}>No contacts</td></tr>
          ) : (
            contacts.map((c: any) => (
              <tr key={c.id}>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>{c.name}</td>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>{c.email}</td>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>{c.phone}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
