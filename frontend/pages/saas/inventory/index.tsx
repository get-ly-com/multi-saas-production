import { useEffect, useState } from 'react';
import APIClient from '@/lib/api-client';

export default function Inventory() {
  const [items, setItems] = useState([]);
  const api = new APIClient('inventory');

  useEffect(() => {
    api.getItems().then(({ data }) => setItems(data)).catch(console.error);
  }, []);

  return (
    <div style={{ padding: '20px', maxWidth: '1000px', margin: '0 auto' }}>
      <h1>📦 Inventory Manager</h1>
      <p>Items in Stock: {items.length}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ border: '1px solid #ddd', padding: '10px' }}>SKU</th>
            <th style={{ border: '1px solid #ddd', padding: '10px' }}>Name</th>
            <th style={{ border: '1px solid #ddd', padding: '10px' }}>Quantity</th>
            <th style={{ border: '1px solid #ddd', padding: '10px' }}>Price</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={4} style={{ padding: '20px', textAlign: 'center' }}>No items</td></tr>
          ) : (
            items.map((item: any) => (
              <tr key={item.id}>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>{item.sku}</td>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>{item.name}</td>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>{item.quantity}</td>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>${item.price}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
