import Link from 'next/link';
import AppShell from '@/components/AppShell';
import IntegrationsNav from '@/components/IntegrationsNav';

export default function ApiGuide() {
  return <AppShell><Guide /></AppShell>;
}

const RESOURCES = [
  {
    name: 'contacts',
    label: 'CRM contacts',
    fields: 'id, name, email, phone, job_title, company_id, source, created_at, updated_at'
  },
  {
    name: 'invoices',
    label: 'Invoices',
    fields: 'id, invoice_number, status (draft, sent, partial, paid, void), customer_id, customer_name, invoice_date, due_date, currency, subtotal, tax_amount, amount, amount_paid, amount_credited, paid_at, created_at, updated_at'
  },
  {
    name: 'items',
    label: 'Stock items',
    fields: 'id, sku, name, quantity, price, reorder_level, created_at, updated_at'
  },
  {
    name: 'deals',
    label: 'Deals',
    fields: 'id, title, value, stage, status (open, won, lost), contact_id, company_id, expected_close, closed_at, created_at, updated_at'
  }
];

function Guide() {
  const base = `${process.env.NEXT_PUBLIC_API_BASE_URL || 'https://your-api-address'}/api/v1`;

  return (
    <div className="stack">
      <IntegrationsNav />
      <h1>API guide</h1>
      <p className="muted">
        The API lets your own tools read this company's data. It is read-only for now: nothing can be changed through it.
        Owners and admins make keys on the <Link href="/saas/integrations/keys">API keys</Link> page.
      </p>

      <div className="card">
        <h2>Signing in</h2>
        <p>Send the key in the <code>Authorization</code> header of every request. The key decides which company you read.</p>
        <pre className="code-block">{`curl ${base}/contacts \\
  -H "Authorization: Bearer gk_your_key"`}</pre>
        <p className="muted">Keep keys out of web pages and app code that others can see. Use them from your own server.</p>
      </div>

      <div className="card">
        <h2>Lists and pages</h2>
        <p>
          <code>GET {base}/&lt;resource&gt;?limit=25&amp;offset=0</code> returns the oldest records first. <code>limit</code> is 1 to 100
          (25 if left out). When <code>has_more</code> is true, ask again with <code>offset</code> set to <code>next_offset</code>.
        </p>
        <pre className="code-block">{`curl "${base}/invoices?limit=2" -H "Authorization: Bearer gk_your_key"

{
  "object": "list",
  "resource": "invoices",
  "data": [ { "id": "…", "invoice_number": "INV-0001", "status": "paid", "amount": 120.00, … }, … ],
  "limit": 2,
  "offset": 0,
  "has_more": true,
  "next_offset": 2
}`}</pre>
        <p>
          <code>GET {base}/&lt;resource&gt;/&lt;id&gt;</code> returns one record.
        </p>
        <pre className="code-block">{`curl ${base}/deals/2b1e…-…-…  -H "Authorization: Bearer gk_your_key"`}</pre>
      </div>

      <div className="card table-wrap">
        <h2>Resources</h2>
        <table>
          <thead><tr><th>Resource</th><th>What it is</th><th>Fields</th></tr></thead>
          <tbody>
            {RESOURCES.map((resource) => (
              <tr key={resource.name}>
                <td><code>{resource.name}</code></td>
                <td>{resource.label}</td>
                <td className="muted">{resource.fields}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Dates and times are UTC. Amounts are in the record's own currency.</p>
      </div>

      <div className="card table-wrap">
        <h2>Limits and errors</h2>
        <p>Each key can make 60 requests a minute. Errors come back as <code>{'{ "error": "…" }'}</code> with one of these statuses:</p>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>401</td><td>The key is missing, wrong or revoked</td></tr>
            <tr><td>404</td><td>No such resource or record</td></tr>
            <tr><td>405</td><td>Only GET is allowed</td></tr>
            <tr><td>429</td><td>Too many requests. Wait a minute and try again.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Getting told when things change</h2>
        <p>
          Instead of asking the API again and again, add a <Link href="/saas/integrations">webhook</Link>. We send a signed message to your
          address when an invoice is created or paid, a contact or lead is added, a deal is won or lost, leave is approved or a pay run is approved.
        </p>
      </div>
    </div>
  );
}
