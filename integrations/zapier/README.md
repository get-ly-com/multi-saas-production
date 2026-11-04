# get-ly for Zapier

This folder is a Zapier integration for get-ly. Nothing here is deployed yet. These are the steps
to put it on Zapier, first privately for testing, then in Zapier's public app directory.

## What it does

| In Zapier | Kind | Calls | Works today? |
| --- | --- | --- | --- |
| New Invoice | Trigger (polling) | `GET /api/v1/invoices` | Yes |
| Invoice Paid | Trigger (polling) | `GET /api/v1/invoices`, kept when `status` is `paid` | Yes, with a limit (see below) |
| New Contact | Trigger (polling) | `GET /api/v1/contacts` | Yes |
| New Lead | Trigger (polling) | `GET /api/v1/leads` | Yes |
| New Booking | Trigger (polling) | `GET /api/v1/bookings` | **No**, hidden until the API lists bookings |
| Create Contact | Action | `POST /api/v1/contacts` | Yes, with a "read and write" key |
| Create Lead | Action | `POST /api/v1/leads` | Yes, with a "read and write" key |
| Create Draft Invoice | Action | `POST /api/v1/invoices` | **No**, hidden until the API accepts invoices |

Sign-in is an API key. People make one in get-ly under **Integrations > API keys** and paste it
into Zapier. It is sent as `Authorization: Bearer gk_...`. The connection test reads one contact.

Triggers poll: Zapier asks every few minutes for the newest records and starts the Zap for any it
hasn't seen. No webhooks or new server code are needed.

## Steps for the owner

You need Node.js 18 or newer and a Zapier account. Run these in this folder
(`integrations/zapier`).

1. **Install the Zapier command-line tool**
   `npm install -g zapier-platform-cli`
2. **Install this integration's packages**
   `npm install`
3. **Check it** (optional, works offline)
   `npm run check` then `npm test`
4. **Log in to Zapier**
   `zapier login`
   This opens a prompt for your Zapier email and password, or a deploy key.
5. **Register the integration** (once)
   `zapier register "get-ly"`
   This makes a private integration in your Zapier account and writes a `.zapierapprc` file
   here. Keep that file; it links this folder to the integration.
6. **Tell it where your API is**
   `zapier env:set 1.0.0 GETLY_API_URL=https://your-gateway-address`
   Use the public address of the API gateway (the same one as `NEXT_PUBLIC_API_BASE_URL` in the
   frontend), with no `/api/v1` on the end. Repeat this for each new version number.
7. **Upload it**
   `zapier push`
   Run this again after every change. Change `version` in `package.json` for a new version.
8. **Try it yourself**
   Open zapier.com, make a Zap, search for "get-ly", and connect it with an API key from your
   own get-ly company.
9. **Invite testers**
   `zapier users:add tester@example.com 1.0.0`
   or share the invite link from the integration's **Sharing** page on developer.zapier.com.
10. **Submit it for the public directory**
    On developer.zapier.com, open the integration and fill in **Integration Home**: name, logo,
    description, category, and a link to help docs. Then use **Publishing** to submit. Zapier
    checks it, and asks for live Zaps from real users (at the time of writing, a few active
    users) before it becomes public. Before you submit, fix the gaps below or leave the hidden
    triggers and actions hidden.

## Gaps for the owner

Found by reading `backend/services/api-gateway/server.js` (Public API) and the
`integrations.api_*` database functions:

1. **Bookings are not in the public API.** API keys can read only `contacts`, `invoices`,
   `items`, `deals` and `leads` (`API_RESOURCES` in the gateway, `integrations.api_rows` in the
   database). "New Booking" is written and hidden; add `bookings` to both, then remove
   `hidden: true` in `triggers/new_booking.js`.
2. **API keys cannot create invoices.** Only contacts and leads can be added
   (`API_WRITABLE` in the gateway, `integrations.api_create`). "Create Draft Invoice" is written
   against the app's own invoice body and hidden; it needs a write path for draft invoices, and
   a way to read customers (`/api/v1/customers`) so Zapier can show a customer picker instead of
   asking for an ID.
3. **Lists are oldest first, with no "since" filter.** To find the newest records, the
   integration finds the end of each list with a few one-row requests (about 2 x log2(rows/100)
   per poll). That is fine for thousands of records, but a `?order=desc` or
   `?created_after=` option on `GET /api/v1/:resource` would make each poll one request.
4. **"Invoice Paid" only sees recent invoices.** There is no sort or filter by `paid_at` or
   `updated_at`, so it looks at the last 300 invoices made. An older invoice paid today is missed.
   An `?updated_after=` option, or a `paid_at` sort, would fix it. (Outgoing webhooks already send
   `invoice.paid`; a Zapier REST hook trigger on top of them is another way.)
5. **Rate limits.** Each key gets 60 requests a minute and 20 new records a minute, and each
   company 500 API writes a day. A Zap that adds many contacts at once can hit these; Zapier
   retries a 429 answer later.

## Files

- `index.js`: the integration: sign-in, triggers and actions
- `authentication.js`: the API key field and the connection test
- `lib/api.js`: the API address, the key header, error messages, and reading lists newest first
- `triggers/`: New Invoice, Invoice Paid, New Contact, New Lead, New Booking (hidden)
- `creates/`: Create Contact, Create Lead, Create Draft Invoice (hidden)
- `test/authentication.test.js`: checks the connection test, with the API mocked
