# Business Brain (brain-service)

The Business Brain looks at a company's whole business, proposes ideas with evidence, pros, cons and
risks, **waits for a person to approve**, then carries out the approved actions and later checks
whether they worked. It is also an MCP server, so AI tools (Claude, ChatGPT, Cursor and others) can
connect to it.

**The rule it never breaks: AI proposes, a human approves.** Nothing changes in the business until an
owner or admin approves an idea in the Get-ly app. AI tools connected over MCP can read data, run
analysis and submit ideas, but they can never approve or carry them out. There is no approve tool.

## How it works

1. **Think.** In the app (`POST /api/brain/think`), from the daily job, or from the MCP `think` tool.
   - **Rules first.** These work without any AI key:
     - overdue invoices (a payment link plus a call task);
     - stock that runs out before a restock could arrive (draft purchase orders);
     - quiet deals (follow-up tasks);
     - chats waiting for a reply (assign them to the approver);
     - a 30/60/90-day cash forecast that warns of a dip below zero;
     - one customer bringing in more than 40% of revenue;
     - a draft pay run past its date;
     - an expense account more than twice its 3-month average.
   - **Then the AI layer.** This runs when `ANTHROPIC_API_KEY` is set. Claude gets:
     - the company snapshot (the same one the analytics assistant uses, without payroll totals);
     - the forecast and the rule findings;
     - the open ideas;
     - what this owner approved and rejected before (and why);
     - the action catalog.

     It returns up to 5 ideas as strict JSON. The server checks everything:
     - evidence may only cite numbers that are in the data;
     - each idea needs at least one con and one risk;
     - actions must be in the catalog, with valid parameters, and point only at records the Brain showed it.

     Anything that fails a check is dropped.
   - **Limits and alerts.** Ideas are de-duplicated against open ones and against ones rejected in the
     last 14 days. A company can have at most 10 waiting and one think every 10 minutes. Owners and
     admins get a bell notification ("3 new ideas to review").
2. **Decide.** An owner or admin approves, rejects or asks for changes (`brain.decide` in the
   database checks the role, refuses expired ideas and locks the row).
3. **Carry out.** On approval, each action runs **through the gateway as the approving person**
   (their `Authorization` and company), so every existing permission and validation applies. Each
   step is recorded (`brain.action_runs`) and the result comes back in plain words.
4. **Check.** Each carried-out idea gets a check date (its timeframe). The daily job measures the
   number again, compares it with the starting value and records an outcome: worked, partly or
   didn't. Approvals, rejections, the reasons people gave and the outcomes go into
   `brain.learnings`, which feeds the next think.

### Action catalog (v1)

| type | what it does | goes to |
|---|---|---|
| `create_follow_up` | Adds a task, call or meeting reminder to a CRM contact, deal or lead | `POST /api/crm/activities` |
| `create_lead` | Adds a lead | `POST /api/crm/leads` |
| `create_payment_link` | Makes the invoice's payment link and a ready WhatsApp message link (nothing is sent) | `POST /api/accounting/invoices/:id/payment-link` |
| `create_draft_reorder` | Makes **draft** purchase orders, one per supplier | `POST /api/inventory/reorder` |
| `create_draft_social_post` | Adds a **draft** post with the suggested text in its notes | `POST /api/social-media/posts` |
| `create_goal` | Sets a monthly goal (target above 0) | `POST /api/analytics/goals` |
| `assign_chat` | Gives a waiting chat to someone (`"me"` = the approver) | `POST /api/chatbot/conversations/:id/assign` |

These are never in the catalog: anything that moves money, deletes, voids, sends external email,
changes prices or touches payroll amounts. Ideas about those are advice only (`actions: []`).
Approving advice just records the decision.

## Environment variables

| Service | Variable | What it's for |
|---|---|---|
| brain-service | `SUPABASE_URL` | Supabase project URL |
| | `SUPABASE_ANON_KEY` | For queries as the signed-in person (ideas, decisions) |
| | `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`) | For the Brain's own work. Only calls the `brain.*` and `integrations.*` functions granted to the service role |
| | `GATEWAY_INTERNAL_URL` | Where approved actions are sent. Default `http://api-gateway.railway.internal:3000` in production, `http://localhost:3000` locally. Use the gateway's real private port |
| | `ANTHROPIC_API_KEY` | Turns on the AI layer (optional; the rules work without it) |
| | `BRAIN_MODEL` | Default `claude-sonnet-5-5` |
| | `BRAIN_JOB_SECRET` | Shared with the worker, 16+ characters. Without it the daily endpoints answer 404 |
| | `APP_URL` | Default `https://multi-saas-frontend.vercel.app`. Used for review links and payment links |
| | `PORT` | Default 3013 |
| api-gateway | `BRAIN_SERVICE_URL` | Optional. Overrides `http://brain-service.railway.internal:3013` |
| worker | `BRAIN_JOB_SECRET` | Same value as on brain-service |
| | `BRAIN_SERVICE_URL` | Optional, default `http://brain-service.railway.internal:3013` |
| | `BRAIN_DAILY_HOUR_UTC` | Optional, default `6` (runs at about 06:00 UTC, then every 24 hours) |

## Deploying

Like the other services, this is a plain Node service. On Railway:

1. Create a service from this repo with **Root Directory** `backend/services/brain-service`.
2. Nixpacks detects Node, runs `npm install`, and starts with `npm start` (`node server.js`).
3. Set `PORT=3013`, so the gateway and the worker can reach it at `brain-service.railway.internal:3013`.
4. Generate a public domain for the MCP server.

There is no per-service `railway.json`, `Dockerfile` or `nixpacks.toml`; the repo-root `railway.json`
only sets the restart policy. Node 18 or newer is needed.

**Shared code.** `lib/business.js` holds the to do list builders, the company snapshot and the call
to Claude. It is a copy of `backend/services/analytics-service/business.js`, because Railway builds
each service from its own folder and they can't share a file. After changing the analytics one,
copy it across and run `npm run check-shared`, which fails if the two differ.

**Database.** The database parts are in these migrations (applied):

- `supabase-migration-053-business-brain.sql`
- `053a-brain-outcome-fix.sql`
- `053b-brain-proposal-check.sql`

They add the `brain` schema and extend `integrations.api_list` / `api_rows` with search, newest-first
and the `customers`, `bookings` and `stock_levels` resources. The old four-argument `api_list` calls
behave exactly as before.

## In-app API (through the gateway, `/api/brain/*`)

Every request uses the signed-in person's `Authorization: Bearer <Supabase token>` and the `X-Company` header, like the other apps. Errors are `{ "error": "plain message" }` with a 4xx status.

### The idea object

`Proposal` (as returned everywhere):

```json
{
  "id": "uuid", "title": "Get paid for invoice INV-0007: €1,000.00 from Bolt Ltd, 40 days late",
  "category": "cash | sales | stock | people | marketing | operations | risk",
  "summary": "…",
  "evidence": [{ "fact": "Still owed on invoice INV-0007", "number": 1000, "source": "Accounting invoices" }],
  "pros": ["…"], "cons": ["…"], "risks": ["…"],
  "expected_impact": { "metric": "invoices_owed", "amount": 1000, "currency": "EUR", "timeframe_days": 14, "confidence": 0.55 },
  "effort": "S | M | L",
  "actions": [{ "type": "create_payment_link", "label": "Make a payment link for an invoice", "params": { "invoice_id": "uuid" } }],
  "source": "rules | brain | <AI tool name>",
  "status": "pending | approved | rejected | changes_requested | executing | done | failed | expired",
  "decided_by": "uuid|null", "decided_at": "…", "decision_note": "…",
  "created_at": "…", "expires_at": "…", "executed_at": "…", "check_at": "…",
  "check_spec": { "kind": "invoices_owed", "ids": ["…"], "baseline": 1000, "since": "…" },
  "result_summary": "Payment link ready for invoice INV-0007. …",
  "runs": [{ "position": 0, "action": "create_payment_link", "status": "done | failed | skipped", "result": { "message": "…", "link": "…", "whatsapp_link": "…" }, "error": null, "at": "…" }],
  "outcome": { "metric": "invoices_owed", "baseline": 1000, "value": 0, "verdict": "worked | partly | didnt", "note": "…", "measured_at": "…" }
}
```

### Endpoints

| Method and path | Who | Returns |
|---|---|---|
| `GET /api/brain/proposals?status=open&limit=50` | members | `Proposal[]`. `status`: `open` (pending + changes requested, the default), any single status, or `all` |
| `GET /api/brain/proposals/:id` | members | `Proposal` |
| `POST /api/brain/proposals/:id/approve` `{ "note"?: string }` | owner, admin | `{ proposal, results: [{ action, label, status: "done"\|"failed", message, link, whatsapp_link }], message }`. The idea ends as `done`, or `failed` if any step failed (the steps that worked stay done). Approving an idea left `approved` by an interrupted run carries it out again |
| `POST /api/brain/proposals/:id/reject` `{ "note"?: string }` | owner, admin | `{ proposal, message }` |
| `POST /api/brain/proposals/:id/request-changes` `{ "note": string }` (required) | owner, admin | `{ proposal, message }` |
| `POST /api/brain/think` | owner, admin, accountant | `{ created: Proposal[], skipped: { duplicate, too_many_open }, ai: "used"\|"off"\|"failed", notes: string[], message, forecast_warning, cash_now }`. 429 with a plain message if it ran in the last 10 minutes |
| `GET /api/brain/history?limit=30` | members | `{ decisions: Proposal[], learnings: [{ category, approved, rejected, changes_requested, worked, partly, didnt, recent_notes: [{ title, note, decision, at }] }] }` |
| `GET /api/brain/snapshot` | members | `{ snapshot, cash_balance }`. The snapshot has the same shape as the analytics assistant's, without payroll totals |
| `GET /api/brain/forecast?days=30\|60\|90` | members | `{ currency, today, days, opening_balance, points: [{ days, date, balance, money_in, money_out }], lowest_point: { date, balance }, first_below_zero, warning, assumptions: string[], data_notes: string[] }` |
| `POST /api/brain/simulate` `{ price_change_pct?, volume_change_pct?, expense_change_pct?, new_hire_monthly_cost?, collect_overdue_pct?, months? }` | members | `{ baseline, scenario, change, cash, assumptions, data_notes, … }` |
| `GET /api/brain/catalog` | members | `{ actions: [{ type, label, description, params }] }` |

The review link for an idea is `https://multi-saas-frontend.vercel.app/saas/brain?p=<id>`. The page
should read `p`, and the bell notification links to `/saas/brain`.

**Internal endpoints** (worker only, header `x-brain-secret: $BRAIN_JOB_SECRET`; refused through the gateway):

- `POST /internal/think-all`: expires old ideas, thinks for every active company, then checks outcomes. Answers `202` at once; the progress shows on `/health`.
- `POST /internal/check-outcomes`: checks outcomes only.
- `GET /internal/status`: the last daily run.

## MCP server

`POST https://<brain-domain>/mcp`: Streamable HTTP, stateless, with JSON responses. `GET` and `DELETE` answer 405.

**Auth.** Send `Authorization: Bearer gk_...` with a company API key from **Integrations > API keys**.
Keys are checked by `integrations.api_key_info`, which uses the same key check and per-minute count
as the public API. Every call is logged in the key's request log as `/mcp/<tool or method>`.

**Limits.**
- 60 requests a minute per key and 120 per address.
- 20 new records or ideas a minute per key.
- `think`: 3 an hour per key, and once every 10 minutes per company.

**Tools.** Every tool returns plain text plus `structuredContent`.

| Tool | Keys | Notes |
|---|---|---|
| `get_business_snapshot` | all | read only |
| `forecast_cash` `{ days: 30\|60\|90 }` | all | read only |
| `simulate_scenario` `{ price_change_pct, volume_change_pct, expense_change_pct, new_hire_monthly_cost, collect_overdue_pct, months }` | all | read only, deterministic |
| `search_records` `{ type, query, limit }` | all | `type`: contacts, customers, invoices, items, deals, leads, bookings, stock_levels; newest first |
| `get_record` `{ type, id }` | all | read only |
| `get_todo` | all | the assistant's to do list, for the whole company |
| `think` | all | saves pending ideas only |
| `list_proposals` `{ status }`, `get_proposal` `{ id }` | all | read only, including pros, cons, evidence and outcomes |
| `propose_idea` | all | same checks as the AI layer; saved as pending with `source` = tool name; returns the review link |
| `get_decision_history` | all | decisions, outcomes and learnings |
| `create_lead`, `create_contact` | read-and-write keys only | uses `integrations.api_create` |

**Annotations.** Read tools are marked `readOnlyHint: true`. `think`, `propose_idea` and the create
tools are `readOnlyHint: false` and `destructiveHint: false`. Nothing over MCP can delete or approve.

**Resource and prompts.**
- Resource `getly://company/snapshot`.
- Prompt `weekly_business_review`: gathers the snapshot, forecast, to do list and open ideas, then writes 3 prioritised moves.
- Prompt `decide_with_me` `{ proposal_id }`: walks through an idea's evidence, pros, cons and risks, then sends you to the app to decide.

The server instructions tell every client that approvals happen in the Get-ly app, by an owner or admin.

### Connecting AI tools

Use a dedicated API key per tool so you can see and revoke each one. Choose "read" unless the tool
should add leads and contacts.

- **Claude Code**

  ```sh
  claude mcp add --transport http getly https://<brain-domain>/mcp --header "Authorization: Bearer gk_..."
  ```

- **Claude (claude.ai / desktop):** go to Settings > Connectors > Add custom connector and enter the
  URL `https://<brain-domain>/mcp`. Custom connectors may only offer OAuth or no authentication, with
  no field for a fixed Bearer header. Check current docs for whether a header can be set. If it
  can't, connect through Claude Code or the desktop app's local MCP configuration instead.

- **Cursor:** add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project). Check current docs
  for the exact format.

  ```json
  {
    "mcpServers": {
      "getly": {
        "url": "https://<brain-domain>/mcp",
        "headers": { "Authorization": "Bearer gk_..." }
      }
    }
  }
  ```

- **ChatGPT:** turn on developer mode (Settings > Connectors > Advanced > Developer mode), then
  create a connector with the URL `https://<brain-domain>/mcp`. Check current docs: ChatGPT
  connectors may only support OAuth or no authentication, not a fixed Bearer header.

### Testing locally

```sh
npm install
SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npm start
curl -s -X POST localhost:3013/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer gk_..." \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"simulate_scenario","arguments":{"price_change_pct":5}}}'
```
