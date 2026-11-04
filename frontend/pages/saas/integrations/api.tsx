import Link from 'next/link';
import AppShell from '@/components/AppShell';
import IntegrationsNav, { CodeBlock } from '@/components/IntegrationsNav';

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
    name: 'leads',
    label: 'Leads',
    fields: 'id, name, email, phone, company_name, job_title, source, campaign, status (new, working, disqualified, converted), score, converted_contact_id, converted_at, created_at, updated_at'
  },
  {
    name: 'deals',
    label: 'Deals',
    fields: 'id, title, value, stage, status (open, won, lost), contact_id, company_id, expected_close, closed_at, created_at, updated_at'
  }
];

const WEBHOOK_EVENTS = [
  { name: 'invoice.created', when: 'An invoice is created', fields: 'id, invoice_number, status, customer_id, amount, currency, invoice_date, due_date' },
  { name: 'invoice.paid', when: 'An invoice is paid in full', fields: 'The invoice fields plus amount_paid, paid_at' },
  { name: 'contact.created', when: 'A CRM contact is added', fields: 'id, name, email, company_id, source' },
  { name: 'lead.created', when: 'A lead is added', fields: 'id, name, email, company_name, source, status, from_form' },
  { name: 'deal.won', when: 'A deal moves to a won stage', fields: 'id, title, value, stage_id, stage, contact_id, company_id, closed_at' },
  { name: 'deal.lost', when: 'A deal moves to a lost stage', fields: 'The deal fields plus lost_reason' },
  { name: 'leave.approved', when: 'Leave is approved', fields: 'id, employee_id, leave_type_id, start_date, end_date, half_day, days' },
  { name: 'payrun.approved', when: 'A pay run is approved', fields: 'id, run_number, period_start, period_end, pay_date, gross, deductions, net, employer_costs' },
  { name: 'booking.created', when: 'A booking is made', fields: 'id, service_id, service, staff_id, starts_at, ends_at, status, location_type, source, contact_id, campaign, created_at, customer_name, customer_email' },
  { name: 'booking.cancelled', when: 'A booking is cancelled', fields: 'The booking fields (without customer name and email) plus cancelled_at, cancelled_by_visitor' },
  { name: 'chat.started', when: 'A website visitor starts a chat', fields: 'id, status, started_on, created_at, lead_id, contact_id, campaign' },
  { name: 'chat.handed_over', when: 'A chat first asks for a person', fields: 'The chat fields plus assigned_to, handed_over_at' },
  { name: 'social.posted', when: 'A social post is marked as posted on every account', fields: 'id, title, campaign, tags, link_url, scheduled_at, posted_at, targets (platform, account_id, posted_at, post_url)' }
];

function Guide() {
  const base = `${process.env.NEXT_PUBLIC_API_BASE_URL || 'https://your-api-address'}/api/v1`;

  return (
    <div className="stack">
      <IntegrationsNav />
      <div className="page-head">
        <div>
          <h1>API guide</h1>
          <p className="muted">Read your data from your own tools, and add contacts and leads.</p>
        </div>
        <Link className="button" href="/saas/integrations/keys">Make an API key</Link>
      </div>
      <p className="muted small">
        The API lets your own tools read this company's data, and add contacts and leads. Nothing else can be changed through it.
        Owners and admins make keys on the <Link href="/saas/integrations/keys">API keys</Link> page. A key is either read only, or
        can read and add contacts and leads.
      </p>

      <div className="card">
        <h2>Signing in</h2>
        <p>Send the key in the <code>Authorization</code> header of every request. The key decides which company you read.</p>
        <CodeBlock label="Code copied" value={`curl ${base}/contacts \\
  -H "Authorization: Bearer gk_your_key"`} />
        <p className="muted">Keep keys out of web pages and app code that others can see. Use them from your own server.</p>
      </div>

      <div className="card">
        <h2>Lists and pages</h2>
        <p>
          <code>GET {base}/&lt;resource&gt;?limit=25&amp;offset=0</code> returns the oldest records first. <code>limit</code> is 1 to 100
          (25 if left out). When <code>has_more</code> is true, ask again with <code>offset</code> set to <code>next_offset</code>.
        </p>
        <CodeBlock label="Code copied" value={`curl "${base}/invoices?limit=2" -H "Authorization: Bearer gk_your_key"

{
  "object": "list",
  "resource": "invoices",
  "data": [ { "id": "…", "invoice_number": "INV-0001", "status": "paid", "amount": 120.00, … }, … ],
  "limit": 2,
  "offset": 0,
  "has_more": true,
  "next_offset": 2
}`} />
        <p>
          <code>GET {base}/&lt;resource&gt;/&lt;id&gt;</code> returns one record.
        </p>
        <CodeBlock label="Code copied" value={`curl ${base}/deals/2b1e…-…-…  -H "Authorization: Bearer gk_your_key"`} />
      </div>

      <div className="card">
        <h2>Adding contacts and leads</h2>
        <p>
          <code>POST {base}/contacts</code> or <code>POST {base}/leads</code> with a JSON body. This needs a key that can read and write.
          A name (or <code>first_name</code> and <code>last_name</code>) is needed; a lead also needs an email or a phone number.
        </p>
        <CodeBlock label="Code copied" value={`curl -X POST ${base}/leads   -H "Authorization: Bearer gk_your_key"   -H "Content-Type: application/json"   -d '{"name": "Ada Lovelace", "email": "ada@example.com", "company": "Analytical Engines",
       "phone": "+44 20 7946 0000", "job_title": "Engineer", "message": "Wants a demo",
       "source": "Website", "campaign": "autumn"}'

{ "created": true, "data": { "id": "…", "name": "Ada Lovelace", "status": "new", "source": "Website", … } }`} />
        <p className="muted">
          The answer is <code>201</code> with <code>created: true</code> for a new record. If a contact with that email already exists, or an
          open lead does, you get <code>200</code> with <code>created: false</code> and that record, so sending the same person twice is safe
          (an open lead gets a note with the new message). Without a <code>source</code>, records are marked as coming from the API. Each key
          can add 20 records a minute, and the company up to 500 a day.
        </p>
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
        <p>
          Each key can make 60 requests a minute. Every request is listed in the key's log on the API keys page (the method, address and
          result; never what was sent). Errors come back as <code>{'{ "error": "…" }'}</code> with one of these statuses:
        </p>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>400</td><td>The body isn't valid JSON</td></tr>
            <tr><td>401</td><td>The key is missing, wrong or revoked</td></tr>
            <tr><td>403</td><td>The key can only read</td></tr>
            <tr><td>404</td><td>No such resource or record</td></tr>
            <tr><td>405</td><td>That resource can't be changed through the API</td></tr>
            <tr><td>422</td><td>A field is missing or not valid; the message says which</td></tr>
            <tr><td>429</td><td>Too many requests. Wait a minute (or until tomorrow for the daily limit) and try again.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card table-wrap">
        <h2>Getting told when things change</h2>
        <p>
          To get leads from a tool that can only send to a web address, use an <Link href="/saas/integrations/inbound">incoming webhook</Link>.
          Instead of asking the API again and again, add a <Link href="/saas/integrations">webhook</Link>. We send a signed message to your
          address when one of these happens. The details are in the message's <code>data</code>.
        </p>
        <table>
          <thead><tr><th>Event</th><th>When</th><th>Details</th></tr></thead>
          <tbody>
            {WEBHOOK_EVENTS.map((event) => (
              <tr key={event.name}>
                <td><code>{event.name}</code></td>
                <td>{event.when}</td>
                <td className="muted">{event.fields}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
