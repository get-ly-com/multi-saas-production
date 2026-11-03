-- Run after supabase-migration-040.
-- Customer statements, a "who to chase" list for overdue invoices, bank rules,
-- writing off what a customer will never pay, and a cash-basis profit and loss.

-- ---------------------------------------------------------------------------
-- Write-offs
-- ---------------------------------------------------------------------------
-- A write-off settles an invoice like a payment, but against an expense account
-- instead of a bank account, so no money moves.
ALTER TABLE accounting.payments ADD COLUMN is_write_off BOOLEAN NOT NULL DEFAULT false;

-- Kept in line with the live definition, plus the Bad Debts account
CREATE OR REPLACE FUNCTION accounting.seed_chart(p_tenant uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
  VALUES
    (p_tenant, '1000', 'Cash', 'asset', true, true),
    (p_tenant, '1200', 'Accounts Receivable', 'asset', true, false),
    (p_tenant, '1300', 'Due from Group Companies', 'asset', true, false),
    (p_tenant, '1400', 'Inventory', 'asset', true, false),
    (p_tenant, '1500', 'Fixed Assets', 'asset', true, false),
    (p_tenant, '1590', 'Accumulated Depreciation', 'asset', true, false),
    (p_tenant, '2000', 'Accounts Payable', 'liability', true, false),
    (p_tenant, '2100', 'Tax Payable', 'liability', true, false),
    (p_tenant, '2200', 'Deferred Revenue', 'liability', true, false),
    (p_tenant, '2300', 'Due to Group Companies', 'liability', true, false),
    (p_tenant, '2400', 'Payroll Liabilities', 'liability', true, false),
    (p_tenant, '2500', 'Wages Payable', 'liability', true, false),
    (p_tenant, '3000', 'Owner''s Equity', 'equity', true, false),
    (p_tenant, '3100', 'Retained Earnings', 'equity', true, false),
    (p_tenant, '4000', 'Sales Revenue', 'revenue', true, false),
    (p_tenant, '5000', 'Cost of Goods Sold', 'expense', true, false),
    (p_tenant, '5100', 'Stock Adjustments', 'expense', true, false),
    (p_tenant, '6000', 'General Expenses', 'expense', true, false),
    (p_tenant, '6100', 'Depreciation Expense', 'expense', true, false),
    (p_tenant, '6200', 'Salaries and Wages', 'expense', true, false),
    (p_tenant, '6210', 'Employer Payroll Costs', 'expense', true, false),
    (p_tenant, '6300', 'Bad Debts', 'expense', true, false),
    (p_tenant, '7000', 'Gain or Loss on Disposal', 'expense', true, false),
    (p_tenant, '7100', 'Exchange Gain or Loss', 'expense', true, false)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$function$;

INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
  SELECT id, '6300', 'Bad Debts', 'expense', true, false FROM public.tenants
  ON CONFLICT (tenant_id, code) DO NOTHING;

CREATE OR REPLACE FUNCTION accounting.write_off_invoice(
  p_tenant UUID, p_invoice UUID, p_date DATE, p_account UUID, p_reason TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  balance NUMERIC;
  base_open NUMERIC;
  locked_through DATE;
  new_id UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Choose a date';
  END IF;
  IF length(trim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT * INTO invoice FROM accounting.invoices WHERE id = p_invoice AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF invoice.status NOT IN ('sent', 'partial') THEN
    RAISE EXCEPTION 'Only sent invoices with a balance can be written off';
  END IF;
  IF p_date < invoice.invoice_date THEN
    RAISE EXCEPTION 'The write-off date cannot be before the invoice date';
  END IF;

  balance := invoice.amount - invoice.amount_paid - invoice.amount_credited;
  base_open := invoice.base_amount - invoice.base_settled;
  IF balance <= 0 THEN
    RAISE EXCEPTION 'This invoice has nothing left to write off';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts
    WHERE id = p_account AND tenant_id = p_tenant AND is_active AND type = 'expense' AND NOT is_cash
  ) THEN
    RAISE EXCEPTION 'Choose an expense account, such as Bad Debts';
  END IF;

  SELECT lock_date INTO locked_through FROM accounting.settings WHERE tenant_id = p_tenant;
  IF p_date <= locked_through THEN
    RAISE EXCEPTION 'The books are locked through %. Use a later date.', locked_through;
  END IF;

  INSERT INTO accounting.payments
      (tenant_id, invoice_id, account_id, payment_date, amount, reference, exchange_rate, base_amount, control_amount, is_write_off)
    VALUES (p_tenant, p_invoice, p_account, p_date, balance, 'Written off: ' || trim(p_reason),
      invoice.exchange_rate, base_open, base_open, true)
    RETURNING id INTO new_id;

  -- Usually the base-currency balance is above zero. Rounding can leave it at zero, and then nothing is posted.
  IF base_open <> 0 THEN
    PERFORM accounting.insert_entry(
      p_tenant, p_date, 'Write-off for ' || invoice.invoice_number, 'payment', new_id, NULL,
      jsonb_build_array(
        jsonb_build_object('account_id', p_account, 'debit', greatest(base_open, 0), 'credit', greatest(-base_open, 0),
          'cost_center_id', invoice.cost_center_id),
        jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '1200'),
          'debit', greatest(-base_open, 0), 'credit', greatest(base_open, 0))
      )
    );
  END IF;

  UPDATE accounting.invoices SET updated_at = now() WHERE id = p_invoice;
  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Customer statements
-- ---------------------------------------------------------------------------
-- Everything that changed what the customer owes, in the main currency, with a running balance.
CREATE OR REPLACE FUNCTION accounting.customer_statement(p_tenant UUID, p_customer UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  customer accounting.customers;
  result JSON;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Choose a start date on or before the end date';
  END IF;
  SELECT * INTO customer FROM accounting.customers WHERE id = p_customer AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  WITH moves AS (
    SELECT i.invoice_date AS move_date, 1 AS sort_order, i.created_at, 'invoice' AS kind,
      i.invoice_number AS reference, i.id AS invoice_id, i.due_date,
      coalesce(nullif(i.description, ''), 'Invoice') AS description,
      i.base_amount AS change
    FROM accounting.invoices i
    WHERE i.tenant_id = p_tenant AND i.customer_id = p_customer AND i.status IN ('sent', 'partial', 'paid')
    UNION ALL
    SELECT p.payment_date, 2, p.created_at, CASE WHEN p.is_write_off THEN 'write_off' ELSE 'payment' END,
      i.invoice_number, i.id, NULL,
      CASE WHEN p.is_write_off THEN 'Written off' ELSE 'Payment' || coalesce(' · ' || p.reference, '') END,
      -p.control_amount
    FROM accounting.payments p
    JOIN accounting.invoices i ON i.id = p.invoice_id
    WHERE p.tenant_id = p_tenant AND i.customer_id = p_customer AND p.voided_at IS NULL
    UNION ALL
    -- Refunds pay money back, so they don't change what is owed
    SELECT c.credit_date, 3, c.created_at, 'credit_note', c.credit_number, i.id, NULL,
      'Credit note for ' || i.invoice_number || ' · ' || c.reason,
      -c.base_amount
    FROM accounting.credit_notes c
    JOIN accounting.invoices i ON i.id = c.invoice_id
    WHERE c.tenant_id = p_tenant AND i.customer_id = p_customer AND c.voided_at IS NULL AND c.refund_account_id IS NULL
  ), opening AS (
    SELECT coalesce(sum(change), 0) AS amount FROM moves WHERE move_date < p_from
  ), lines AS (
    SELECT m.*, (SELECT amount FROM opening)
      + sum(change) OVER (ORDER BY move_date, sort_order, created_at, reference ROWS UNBOUNDED PRECEDING) AS balance
    FROM moves m
    WHERE move_date BETWEEN p_from AND p_to
  ), open_items AS (
    -- What was still owed on each invoice at the end date
    SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.base_amount,
      i.base_amount
        - coalesce((SELECT sum(p.control_amount) FROM accounting.payments p
                    WHERE p.invoice_id = i.id AND p.voided_at IS NULL AND p.payment_date <= p_to), 0)
        - coalesce((SELECT sum(c.base_amount) FROM accounting.credit_notes c
                    WHERE c.invoice_id = i.id AND c.voided_at IS NULL AND c.refund_account_id IS NULL
                      AND c.credit_date <= p_to), 0) AS open_amount,
      p_to - coalesce(i.due_date, i.invoice_date) AS days_overdue
    FROM accounting.invoices i
    WHERE i.tenant_id = p_tenant AND i.customer_id = p_customer
      AND i.status IN ('sent', 'partial', 'paid') AND i.invoice_date <= p_to
  ), owed AS (
    SELECT * FROM open_items WHERE open_amount <> 0
  )
  SELECT json_build_object(
    'customer', json_build_object('id', customer.id, 'name', customer.name, 'email', customer.email,
      'phone', customer.phone, 'address', customer.address),
    'currency', accounting.base_currency(p_tenant),
    'from', p_from,
    'to', p_to,
    'opening', (SELECT amount FROM opening),
    'invoiced', coalesce((SELECT sum(change) FROM lines WHERE kind = 'invoice'), 0),
    'received', -coalesce((SELECT sum(change) FROM lines WHERE kind = 'payment'), 0),
    'credited', -coalesce((SELECT sum(change) FROM lines WHERE kind IN ('credit_note', 'write_off')), 0),
    'closing', (SELECT amount FROM opening) + coalesce((SELECT sum(change) FROM lines), 0),
    'lines', coalesce((
      SELECT json_agg(json_build_object(
        'date', move_date, 'kind', kind, 'reference', reference, 'invoice_id', invoice_id, 'due_date', due_date,
        'description', description,
        'charge', greatest(change, 0), 'credit', greatest(-change, 0), 'balance', balance
      ) ORDER BY move_date, sort_order, created_at, reference) FROM lines
    ), '[]'::json),
    'open_invoices', coalesce((
      SELECT json_agg(json_build_object(
        'id', id, 'invoice_number', invoice_number, 'invoice_date', invoice_date, 'due_date', due_date,
        'amount', base_amount, 'open', open_amount, 'days_overdue', greatest(days_overdue, 0)
      ) ORDER BY invoice_date, invoice_number) FROM owed
    ), '[]'::json),
    'ageing', (SELECT json_build_object(
      'not_due', coalesce(sum(open_amount) FILTER (WHERE days_overdue <= 0), 0),
      'days_1_30', coalesce(sum(open_amount) FILTER (WHERE days_overdue BETWEEN 1 AND 30), 0),
      'days_31_60', coalesce(sum(open_amount) FILTER (WHERE days_overdue BETWEEN 31 AND 60), 0),
      'days_61_90', coalesce(sum(open_amount) FILTER (WHERE days_overdue BETWEEN 61 AND 90), 0),
      'days_over_90', coalesce(sum(open_amount) FILTER (WHERE days_overdue > 90), 0),
      'total', coalesce(sum(open_amount), 0)
    ) FROM owed)
  ) INTO result;

  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Follow-ups: who to chase for overdue invoices
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.followup_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  days_overdue INT NOT NULL CHECK (days_overdue BETWEEN 1 AND 3650),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, days_overdue)
);

CREATE TABLE accounting.followup_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES accounting.customers(id) ON DELETE CASCADE,
  level_name TEXT,
  note TEXT CHECK (length(note) <= 2000),
  next_date DATE,
  created_by UUID,
  created_by_email TEXT,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_followup_notes_customer ON accounting.followup_notes(customer_id, created_at DESC);
CREATE INDEX idx_followup_notes_tenant ON accounting.followup_notes(tenant_id);

-- The steps a company starts with, until it saves its own
CREATE OR REPLACE FUNCTION accounting.default_followup_levels()
RETURNS TABLE (days_overdue INT, name TEXT, message TEXT)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  VALUES
    (1, 'Friendly reminder',
     E'Hello {customer},\n\nJust a friendly reminder that the following invoices are now past due:\n\n{invoices}\n\nTotal overdue: {total}\n\nIf you have already paid, please ignore this message. Otherwise we would be grateful if you could arrange payment soon.\n\nThank you,\n{company}'),
    (15, 'Second reminder',
     E'Hello {customer},\n\nWe have not yet received payment for the following invoices, which are now {days} days past due:\n\n{invoices}\n\nTotal overdue: {total}\n\nPlease arrange payment this week, or let us know if there is a problem with any of these invoices.\n\nKind regards,\n{company}'),
    (45, 'Final notice',
     E'Hello {customer},\n\nDespite our earlier reminders, the following invoices remain unpaid, the oldest now {days} days past due:\n\n{invoices}\n\nTotal overdue: {total}\n\nPlease pay the full amount within 7 days. If we do not hear from you, we may have to pause further work or orders.\n\nRegards,\n{company}');
$$;

CREATE OR REPLACE FUNCTION accounting.followup_list(p_tenant UUID)
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH saved AS (
    SELECT l.days_overdue, l.name, l.message FROM accounting.followup_levels l WHERE l.tenant_id = p_tenant
  ), levels AS (
    SELECT * FROM saved
    UNION ALL
    SELECT d.days_overdue, d.name, d.message FROM accounting.default_followup_levels() d
    WHERE NOT EXISTS (SELECT 1 FROM saved)
  ), open_invoices AS (
    SELECT i.id, i.customer_id, i.invoice_number, i.invoice_date, i.due_date, i.currency,
      i.amount - i.amount_paid - i.amount_credited AS balance,
      i.base_amount - i.base_settled AS base_balance,
      current_date - coalesce(i.due_date, i.invoice_date) AS days
    FROM accounting.invoices i
    WHERE i.tenant_id = p_tenant AND i.status IN ('sent', 'partial')
  ), party_totals AS (
    SELECT o.customer_id,
      sum(o.base_balance) FILTER (WHERE o.days > 0) AS overdue_total,
      sum(o.base_balance) AS open_total,
      max(o.days) AS oldest_days,
      count(*) FILTER (WHERE o.days > 0) AS overdue_count
    FROM open_invoices o
    GROUP BY o.customer_id
    HAVING max(o.days) > 0
  ), rows AS (
    SELECT c.id AS customer_id, c.name, c.email, x.overdue_total, x.open_total, x.oldest_days, x.overdue_count,
      lvl.name AS level_name, lvl.days_overdue AS level_days, lvl.message,
      note.created_at AS last_at, note.level_name AS last_level, note.note AS last_note,
      note.created_by_email AS last_by, note.next_date,
      (note.next_date IS NOT NULL AND note.next_date > current_date) AS snoozed,
      coalesce((
        SELECT json_agg(json_build_object(
          'id', o.id, 'invoice_number', o.invoice_number, 'invoice_date', o.invoice_date, 'due_date', o.due_date,
          'currency', o.currency, 'balance', o.balance, 'base_balance', o.base_balance, 'days', o.days
        ) ORDER BY o.days DESC, o.invoice_number)
        FROM open_invoices o WHERE o.customer_id = c.id AND o.days > 0
      ), '[]'::json) AS invoices
    FROM party_totals x
    JOIN accounting.customers c ON c.id = x.customer_id
    LEFT JOIN LATERAL (
      SELECT * FROM levels l WHERE l.days_overdue <= x.oldest_days ORDER BY l.days_overdue DESC LIMIT 1
    ) lvl ON true
    LEFT JOIN LATERAL (
      SELECT * FROM accounting.followup_notes n
      WHERE n.customer_id = c.id AND n.tenant_id = p_tenant
      ORDER BY n.created_at DESC LIMIT 1
    ) note ON true
  )
  SELECT json_build_object(
    'currency', accounting.base_currency(p_tenant),
    'using_defaults', NOT EXISTS (SELECT 1 FROM saved),
    'levels', coalesce((SELECT json_agg(l ORDER BY l.days_overdue) FROM levels l), '[]'::json),
    'rows', coalesce((SELECT json_agg(r ORDER BY r.snoozed, r.oldest_days DESC, r.name) FROM rows r), '[]'::json),
    'totals', (SELECT json_build_object(
      'customers', count(*),
      'to_chase', count(*) FILTER (WHERE NOT snoozed),
      'overdue', coalesce(sum(overdue_total), 0)
    ) FROM rows)
  );
$$;

CREATE OR REPLACE FUNCTION accounting.followup_history(p_tenant UUID, p_customer UUID)
RETURNS SETOF accounting.followup_notes
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT * FROM accounting.followup_notes
  WHERE tenant_id = p_tenant AND customer_id = p_customer
  ORDER BY created_at DESC
  LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION accounting.log_followup(
  p_tenant UUID, p_customer UUID, p_level TEXT, p_note TEXT, p_next DATE
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_id UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM accounting.customers WHERE id = p_customer AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  IF length(coalesce(p_note, '')) > 2000 THEN
    RAISE EXCEPTION 'Keep the note under 2000 characters';
  END IF;
  IF p_next IS NOT NULL AND (p_next < current_date OR p_next > current_date + 365) THEN
    RAISE EXCEPTION 'Choose a next follow-up date within the next year';
  END IF;

  INSERT INTO accounting.followup_notes (tenant_id, customer_id, level_name, note, next_date, created_by, created_by_email)
    VALUES (p_tenant, p_customer, nullif(left(trim(coalesce(p_level, '')), 80), ''), nullif(trim(coalesce(p_note, '')), ''),
      p_next, auth.uid(), auth.jwt()->>'email')
    RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- Replaces the company's steps with the list given
CREATE OR REPLACE FUNCTION accounting.save_followup_levels(p_tenant UUID, p_levels JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF jsonb_typeof(p_levels) <> 'array' OR jsonb_array_length(p_levels) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Add between one and ten steps';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_levels) l
    WHERE coalesce(l->>'days_overdue', '') !~ '^\d{1,4}$'
      OR (l->>'days_overdue')::int NOT BETWEEN 1 AND 3650
      OR length(trim(coalesce(l->>'name', ''))) NOT BETWEEN 1 AND 80
      OR length(trim(coalesce(l->>'message', ''))) NOT BETWEEN 1 AND 4000
  ) THEN
    RAISE EXCEPTION 'Each step needs a name, a message and a number of days overdue from 1 to 3650';
  END IF;
  IF (SELECT count(DISTINCT (l->>'days_overdue')::int) FROM jsonb_array_elements(p_levels) l) <> jsonb_array_length(p_levels) THEN
    RAISE EXCEPTION 'Two steps cannot start on the same day';
  END IF;

  DELETE FROM accounting.followup_levels WHERE tenant_id = p_tenant;
  INSERT INTO accounting.followup_levels (tenant_id, days_overdue, name, message)
    SELECT p_tenant, (l->>'days_overdue')::int, trim(l->>'name'), trim(l->>'message')
    FROM jsonb_array_elements(p_levels) l;
END;
$$;

-- ---------------------------------------------------------------------------
-- Bank rules
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.bank_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  match_text TEXT NOT NULL CHECK (length(trim(match_text)) BETWEEN 1 AND 120),
  direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'in', 'out')),
  min_amount NUMERIC(14, 2) CHECK (min_amount >= 0),
  max_amount NUMERIC(14, 2) CHECK (max_amount >= 0),
  bank_account_id UUID REFERENCES accounting.accounts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  memo TEXT CHECK (length(memo) <= 200),
  position INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  CHECK (min_amount IS NULL OR max_amount IS NULL OR min_amount <= max_amount)
);
CREATE INDEX idx_bank_rules_tenant ON accounting.bank_rules(tenant_id, position);
CREATE INDEX idx_bank_rules_account ON accounting.bank_rules(account_id);
CREATE INDEX idx_bank_rules_bank_account ON accounting.bank_rules(bank_account_id);

-- The first active rule, in order, that fits each unmatched line. Lines that already
-- look like a recorded payment are left alone, since those should be matched instead.
CREATE OR REPLACE FUNCTION accounting.bank_rule_matches(p_tenant UUID, p_account UUID)
RETURNS TABLE (line_id UUID, rule_id UUID, rule_name TEXT, account_id UUID, account_label TEXT, memo TEXT)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT b.id, r.id, r.name, r.account_id, a.code || ' ' || a.name, coalesce(nullif(trim(r.memo), ''), b.description)
  FROM accounting.bank_lines b
  CROSS JOIN LATERAL (
    SELECT r.* FROM accounting.bank_rules r
    WHERE r.tenant_id = p_tenant AND r.is_active
      AND (r.bank_account_id IS NULL OR r.bank_account_id = b.account_id)
      AND strpos(lower(b.description), lower(trim(r.match_text))) > 0
      AND (r.direction = 'any' OR (r.direction = 'in' AND b.amount > 0) OR (r.direction = 'out' AND b.amount < 0))
      AND (r.min_amount IS NULL OR abs(b.amount) >= r.min_amount)
      AND (r.max_amount IS NULL OR abs(b.amount) <= r.max_amount)
    ORDER BY r.position, r.created_at
    LIMIT 1
  ) r
  JOIN accounting.accounts a ON a.id = r.account_id AND a.is_active
  WHERE b.tenant_id = p_tenant AND b.account_id = p_account AND b.status = 'unmatched'
    AND b.fingerprint NOT LIKE 'manual:%'
    AND NOT EXISTS (
      SELECT 1
      FROM accounting.journal_lines l
      JOIN accounting.journal_entries e ON e.id = l.entry_id
      WHERE l.tenant_id = p_tenant AND l.account_id = b.account_id
        AND l.debit - l.credit = b.amount
        AND abs(e.entry_date - b.line_date) <= 7
        AND NOT EXISTS (SELECT 1 FROM accounting.bank_lines used WHERE used.journal_line_id = l.id)
    );
$$;

CREATE OR REPLACE FUNCTION accounting.save_bank_rule(
  p_tenant UUID, p_id UUID, p_name TEXT, p_text TEXT, p_direction TEXT, p_min NUMERIC, p_max NUMERIC,
  p_bank_account UUID, p_account UUID, p_memo TEXT, p_position INT, p_active BOOLEAN
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  rule_id UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF length(trim(coalesce(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'Name is required';
  END IF;
  IF length(trim(coalesce(p_text, ''))) = 0 THEN
    RAISE EXCEPTION 'Enter the words to look for in the description';
  END IF;
  IF coalesce(p_direction, '') NOT IN ('any', 'in', 'out') THEN
    RAISE EXCEPTION 'Choose money in, money out or either';
  END IF;
  IF p_min < 0 OR p_max < 0 OR (p_min IS NOT NULL AND p_max IS NOT NULL AND p_min > p_max) THEN
    RAISE EXCEPTION 'The smallest amount must be zero or more and no bigger than the largest';
  END IF;
  IF p_bank_account IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM accounting.accounts WHERE id = p_bank_account AND tenant_id = p_tenant AND is_cash
  ) THEN
    RAISE EXCEPTION 'Choose a cash or bank account';
  END IF;
  -- The same accounts a statement line can be posted to by hand
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts
    WHERE id = p_account AND tenant_id = p_tenant AND is_active
      AND id IS DISTINCT FROM p_bank_account AND code NOT IN ('1200', '2000')
  ) THEN
    RAISE EXCEPTION 'Choose another account. Customer and vendor money should be matched to its payment.';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO accounting.bank_rules
        (tenant_id, name, match_text, direction, min_amount, max_amount, bank_account_id, account_id, memo, position, is_active)
      VALUES (p_tenant, trim(p_name), trim(p_text), p_direction, p_min, p_max, p_bank_account, p_account,
        nullif(trim(coalesce(p_memo, '')), ''), coalesce(p_position, 100), coalesce(p_active, true))
      RETURNING id INTO rule_id;
  ELSE
    UPDATE accounting.bank_rules SET
        name = trim(p_name), match_text = trim(p_text), direction = p_direction, min_amount = p_min, max_amount = p_max,
        bank_account_id = p_bank_account, account_id = p_account, memo = nullif(trim(coalesce(p_memo, '')), ''),
        position = coalesce(p_position, position), is_active = coalesce(p_active, is_active)
      WHERE id = p_id AND tenant_id = p_tenant
      RETURNING id INTO rule_id;
    IF rule_id IS NULL THEN
      RAISE EXCEPTION 'Rule not found';
    END IF;
  END IF;
  RETURN rule_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.delete_bank_rule(p_tenant UUID, p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  DELETE FROM accounting.bank_rules WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rule not found';
  END IF;
END;
$$;

-- Posts every line a rule fits. A line that can't be posted, such as one in a locked period, is skipped.
CREATE OR REPLACE FUNCTION accounting.apply_bank_rules(p_tenant UUID, p_account UUID, p_lines UUID[] DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  hit RECORD;
  posted INT := 0;
  skipped INT := 0;
BEGIN
  PERFORM accounting.require_bank_account(p_tenant, p_account);
  PERFORM accounting.require_member(p_tenant);

  FOR hit IN
    SELECT * FROM accounting.bank_rule_matches(p_tenant, p_account) m
    WHERE p_lines IS NULL OR m.line_id = ANY (p_lines)
  LOOP
    BEGIN
      PERFORM accounting.post_bank_line(p_tenant, hit.line_id, hit.account_id, hit.memo);
      posted := posted + 1;
    EXCEPTION WHEN raise_exception THEN
      skipped := skipped + 1;
    END;
  END LOOP;

  RETURN json_build_object('posted', posted, 'skipped', skipped);
END;
$$;

-- ---------------------------------------------------------------------------
-- Cash-basis profit and loss
-- ---------------------------------------------------------------------------
-- Sales and bills count when they are paid, in proportion to what was paid. Credit notes
-- and vendor credits only lower what will be paid, so they are left out; the payments
-- already reflect them. Write-offs move no money. Everything else counts on its date.
CREATE OR REPLACE FUNCTION accounting.profit_and_loss_cash(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH direct AS (
    SELECT l.account_id,
      CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE l.debit - l.credit END AS amount
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    LEFT JOIN accounting.payments wp ON e.source_type = 'payment' AND wp.id = e.source_id AND wp.is_write_off
    LEFT JOIN accounting.credit_notes cn ON e.source_type = 'credit_note' AND cn.id = e.source_id
    WHERE l.tenant_id = p_tenant AND a.type IN ('revenue', 'expense')
      AND e.entry_date BETWEEN p_from AND p_to
      AND e.source_type NOT IN ('closing', 'invoice', 'invoice_cost', 'bill', 'vendor_credit')
      AND wp.id IS NULL
      AND NOT (e.source_type = 'credit_note' AND cn.refund_account_id IS NULL)
  ), settled AS (
    -- Money received or paid in the period against each document, in the main currency.
    -- Voiding a payment posts a reversal, which counts against the period it falls in.
    SELECT p.invoice_id, p.bill_id,
      sum(CASE WHEN p.invoice_id IS NOT NULL THEN l.credit - l.debit ELSE l.debit - l.credit END) AS amount
    FROM accounting.journal_entries e
    JOIN accounting.payments p ON p.id = e.source_id AND NOT p.is_write_off
    JOIN accounting.journal_lines l ON l.entry_id = e.id
    JOIN accounting.accounts a ON a.id = l.account_id
      AND a.code = CASE WHEN p.invoice_id IS NOT NULL THEN '1200' ELSE '2000' END
    WHERE e.tenant_id = p_tenant AND e.source_type = 'payment' AND e.entry_date BETWEEN p_from AND p_to
    GROUP BY p.invoice_id, p.bill_id
  ), shares AS (
    SELECT s.amount / d.base_amount AS share, d.source_type, d.id
    FROM settled s
    JOIN LATERAL (
      SELECT i.id, i.base_amount, 'invoice' AS source_type FROM accounting.invoices i WHERE i.id = s.invoice_id
      UNION ALL
      SELECT b.id, b.base_amount, 'bill' FROM accounting.bills b WHERE b.id = s.bill_id
    ) d ON d.base_amount > 0
    WHERE s.amount <> 0
  ), allocated AS (
    SELECT l.account_id,
      round(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE l.debit - l.credit END * sh.share, 2) AS amount
    FROM shares sh
    JOIN accounting.journal_entries e ON e.source_id = sh.id
      AND e.source_type IN (sh.source_type, CASE WHEN sh.source_type = 'invoice' THEN 'invoice_cost' END)
      AND e.reversal_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM accounting.journal_entries r WHERE r.reversal_of = e.id)
    JOIN accounting.journal_lines l ON l.entry_id = e.id
    JOIN accounting.accounts a ON a.id = l.account_id AND a.type IN ('revenue', 'expense')
    WHERE e.tenant_id = p_tenant
  ), rows AS (
    SELECT a.id AS account_id, a.code, a.name, a.type, sum(x.amount) AS amount
    FROM (SELECT * FROM direct UNION ALL SELECT * FROM allocated) x
    JOIN accounting.accounts a ON a.id = x.account_id
    GROUP BY a.id
    HAVING sum(x.amount) <> 0
  ), totals AS (
    SELECT
      coalesce(sum(amount) FILTER (WHERE type = 'revenue'), 0) AS revenue,
      coalesce(sum(amount) FILTER (WHERE type = 'expense'), 0) AS expenses,
      coalesce(sum(amount) FILTER (WHERE code IN ('5000', '5100')), 0) AS cost_of_sales
    FROM rows
  )
  SELECT json_build_object(
    'basis', 'cash',
    'revenue', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'revenue'), '[]'::json),
    'expenses', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'expense'), '[]'::json),
    'total_revenue', totals.revenue,
    'total_expenses', totals.expenses,
    'cost_of_sales', totals.cost_of_sales,
    'gross_profit', totals.revenue - totals.cost_of_sales,
    'net_income', totals.revenue - totals.expenses
  ) FROM totals;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
ALTER TABLE accounting.followup_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.followup_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.bank_rules ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'accounting.followup_levels', 'accounting.followup_notes', 'accounting.bank_rules'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_rows ON %s FOR SELECT TO authenticated
         USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))',
      target
    );
    EXECUTE format('GRANT SELECT ON %s TO authenticated', target);
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION accounting.audit_row()',
      target
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  accounting.write_off_invoice(UUID, UUID, DATE, UUID, TEXT),
  accounting.customer_statement(UUID, UUID, DATE, DATE),
  accounting.default_followup_levels(),
  accounting.followup_list(UUID),
  accounting.followup_history(UUID, UUID),
  accounting.log_followup(UUID, UUID, TEXT, TEXT, DATE),
  accounting.save_followup_levels(UUID, JSONB),
  accounting.bank_rule_matches(UUID, UUID),
  accounting.save_bank_rule(UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, UUID, TEXT, INT, BOOLEAN),
  accounting.delete_bank_rule(UUID, UUID),
  accounting.apply_bank_rules(UUID, UUID, UUID[]),
  accounting.profit_and_loss_cash(UUID, DATE, DATE)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  accounting.write_off_invoice(UUID, UUID, DATE, UUID, TEXT),
  accounting.customer_statement(UUID, UUID, DATE, DATE),
  accounting.default_followup_levels(),
  accounting.followup_list(UUID),
  accounting.followup_history(UUID, UUID),
  accounting.log_followup(UUID, UUID, TEXT, TEXT, DATE),
  accounting.save_followup_levels(UUID, JSONB),
  accounting.bank_rule_matches(UUID, UUID),
  accounting.save_bank_rule(UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, UUID, TEXT, INT, BOOLEAN),
  accounting.delete_bank_rule(UUID, UUID),
  accounting.apply_bank_rules(UUID, UUID, UUID[]),
  accounting.profit_and_loss_cash(UUID, DATE, DATE)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
