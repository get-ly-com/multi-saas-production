-- Run after supabase-migration-006.
-- Tax on invoices and bills, bank statement import, matching and reconciliation.
ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN ('manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note', 'bank'));

-- A rate never changes once created, so posted documents always agree with it. A new rate replaces it.
CREATE TABLE accounting.tax_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  rate NUMERIC(6, 3) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_tax_rates_tenant ON accounting.tax_rates(tenant_id);

ALTER TABLE accounting.invoices
  ADD COLUMN subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE accounting.bills
  ADD COLUMN subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE accounting.credit_notes
  ADD COLUMN tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;

UPDATE accounting.invoices SET subtotal = amount;
UPDATE accounting.bills SET subtotal = amount;

CREATE TABLE accounting.reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  statement_date DATE NOT NULL,
  statement_balance NUMERIC(14, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_reconciliations_account ON accounting.reconciliations(account_id);
CREATE INDEX idx_reconciliations_tenant ON accounting.reconciliations(tenant_id);

-- One row per statement line. Book lines cleared by hand get a row too, marked by their fingerprint.
CREATE TABLE accounting.bank_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  line_date DATE NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount <> 0),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'ignored')),
  journal_line_id UUID REFERENCES accounting.journal_lines(id),
  reconciliation_id UUID REFERENCES accounting.reconciliations(id),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, account_id, fingerprint),
  CHECK ((status = 'matched') = (journal_line_id IS NOT NULL))
);
CREATE UNIQUE INDEX idx_bank_lines_one_match ON accounting.bank_lines(journal_line_id) WHERE journal_line_id IS NOT NULL;
CREATE INDEX idx_bank_lines_account ON accounting.bank_lines(account_id, line_date);
CREATE INDEX idx_bank_lines_reconciliation ON accounting.bank_lines(reconciliation_id);

ALTER TABLE accounting.tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.bank_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON accounting.tax_rates FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.reconciliations FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.bank_lines FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));

GRANT SELECT ON accounting.tax_rates, accounting.reconciliations, accounting.bank_lines TO authenticated;
GRANT INSERT (tenant_id, name, rate) ON accounting.tax_rates TO authenticated;
GRANT UPDATE (name, is_active) ON accounting.tax_rates TO authenticated;

CREATE OR REPLACE FUNCTION accounting.seed_chart(p_tenant UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
  VALUES
    (p_tenant, '1000', 'Cash', 'asset', true, true),
    (p_tenant, '1200', 'Accounts Receivable', 'asset', true, false),
    (p_tenant, '2000', 'Accounts Payable', 'liability', true, false),
    (p_tenant, '2100', 'Tax Payable', 'liability', true, false),
    (p_tenant, '3000', 'Owner''s Equity', 'equity', true, false),
    (p_tenant, '3100', 'Retained Earnings', 'equity', true, false),
    (p_tenant, '4000', 'Sales Revenue', 'revenue', true, false),
    (p_tenant, '5000', 'Cost of Goods Sold', 'expense', true, false),
    (p_tenant, '6000', 'General Expenses', 'expense', true, false)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$$;
SELECT accounting.seed_chart(id) FROM public.tenants;

-- Totals and tax are always worked out here, so they cannot disagree with the lines.
CREATE OR REPLACE FUNCTION accounting.prepare_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  paid NUMERIC;
  credited NUMERIC;
BEGIN
  IF jsonb_typeof(NEW.line_items) <> 'array' OR jsonb_array_length(NEW.line_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one line item';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id' AND t.tenant_id = NEW.tenant_id
    WHERE coalesce(l->>'tax_rate_id', '') <> '' AND t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Tax rate not found';
  END IF;

  SELECT
    sum(base),
    sum(round(base * coalesce(rate, 0) / 100, 2))
  INTO NEW.subtotal, NEW.tax_amount
  FROM (
    SELECT round((l->>'quantity')::numeric * (l->>'unit_price')::numeric, 2) AS base, t.rate
    FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id'
  ) lines;
  NEW.amount := NEW.subtotal + NEW.tax_amount;

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'draft';
    NEW.amount_paid := 0;
    NEW.amount_credited := 0;
    NEW.paid_at := NULL;
  ELSE
    NEW.tenant_id := OLD.tenant_id;
    IF OLD.status = 'void' AND (NEW.status <> 'void' OR NEW.amount <> OLD.amount) THEN
      RAISE EXCEPTION 'A void invoice cannot be changed';
    END IF;
    IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'A posted invoice cannot go back to draft. Void it instead.';
    END IF;
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'The customer can only be changed on a draft invoice';
    END IF;

    SELECT coalesce(sum(amount), 0) INTO paid
      FROM accounting.payments WHERE invoice_id = NEW.id AND voided_at IS NULL;
    SELECT coalesce(sum(amount), 0) INTO credited
      FROM accounting.credit_notes WHERE invoice_id = NEW.id AND voided_at IS NULL;
    NEW.amount_paid := paid;
    NEW.amount_credited := credited;

    IF NEW.status = 'void' THEN
      IF paid + credited > 0 THEN
        RAISE EXCEPTION 'Void this invoice''s payments and credit notes first';
      END IF;
    ELSIF NEW.status <> 'draft' THEN
      IF NEW.amount < paid + credited THEN
        RAISE EXCEPTION 'The total cannot be less than what has been paid and credited';
      END IF;
      IF credited > 0 AND NEW.tax_amount <> OLD.tax_amount THEN
        RAISE EXCEPTION 'Void this invoice''s credit notes before changing its tax';
      END IF;
      NEW.status := CASE
        WHEN NEW.amount = paid + credited THEN 'paid'
        WHEN paid + credited > 0 THEN 'partial'
        ELSE 'sent'
      END;
    END IF;

    SELECT CASE WHEN NEW.status = 'paid' THEN max(payment_date)::timestamp END INTO NEW.paid_at
      FROM accounting.payments WHERE invoice_id = NEW.id AND voided_at IS NULL;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    SELECT name, email INTO NEW.customer_name, NEW.customer_email
      FROM accounting.customers WHERE id = NEW.customer_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.post_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry_lines JSONB;
BEGIN
  IF NEW.status IN ('sent', 'partial', 'paid') AND NEW.amount > 0 THEN
    entry_lines := jsonb_build_array(
      jsonb_build_object('account_id', accounting.account_by_code(NEW.tenant_id, '1200'), 'debit', NEW.amount),
      jsonb_build_object('account_id', accounting.account_by_code(NEW.tenant_id, '4000'), 'credit', NEW.subtotal)
    );
    IF NEW.tax_amount > 0 THEN
      entry_lines := entry_lines || jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '2100'), 'credit', NEW.tax_amount
      );
    END IF;
  END IF;

  PERFORM accounting.sync_entry(
    NEW.tenant_id, 'invoice', NEW.id, NEW.invoice_date, 'Invoice ' || NEW.invoice_number, entry_lines
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.prepare_bill()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  paid NUMERIC;
  next_number BIGINT;
BEGIN
  IF jsonb_typeof(NEW.line_items) <> 'array' OR jsonb_array_length(NEW.line_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one line';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.accounts a
      ON a.id::text = l->>'account_id' AND a.tenant_id = NEW.tenant_id
      AND a.type IN ('expense', 'asset') AND a.code <> '1200' AND NOT a.is_cash
    WHERE a.id IS NULL OR coalesce(round((l->>'amount')::numeric, 2), 0) <= 0
  ) THEN
    RAISE EXCEPTION 'Each line needs an expense or asset account and an amount';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id' AND t.tenant_id = NEW.tenant_id
    WHERE coalesce(l->>'tax_rate_id', '') <> '' AND t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Tax rate not found';
  END IF;

  SELECT sum(base), sum(round(base * coalesce(rate, 0) / 100, 2))
  INTO NEW.subtotal, NEW.tax_amount
  FROM (
    SELECT round((l->>'amount')::numeric, 2) AS base, t.rate
    FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id'
  ) lines;
  NEW.amount := NEW.subtotal + NEW.tax_amount;

  IF NOT EXISTS (
    SELECT 1 FROM accounting.vendors WHERE id = NEW.vendor_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Vendor not found';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 1));
    SELECT coalesce(max(substring(bill_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
      FROM accounting.bills WHERE tenant_id = NEW.tenant_id;
    NEW.bill_number := 'BILL-' || lpad(next_number::text, 4, '0');
    NEW.status := 'draft';
    NEW.amount_paid := 0;
    RETURN NEW;
  END IF;

  NEW.tenant_id := OLD.tenant_id;
  NEW.bill_number := OLD.bill_number;
  IF OLD.status = 'void' AND (NEW.status <> 'void' OR NEW.amount <> OLD.amount) THEN
    RAISE EXCEPTION 'A void bill cannot be changed';
  END IF;
  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'A posted bill cannot go back to draft. Void it instead.';
  END IF;
  IF NEW.vendor_id <> OLD.vendor_id AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'The vendor can only be changed on a draft bill';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO paid
    FROM accounting.payments WHERE bill_id = NEW.id AND voided_at IS NULL;
  NEW.amount_paid := paid;

  IF NEW.status = 'void' THEN
    IF paid > 0 THEN
      RAISE EXCEPTION 'Void this bill''s payments first';
    END IF;
  ELSIF NEW.status <> 'draft' THEN
    IF NEW.amount < paid THEN
      RAISE EXCEPTION 'The total cannot be less than what has been paid';
    END IF;
    NEW.status := CASE
      WHEN NEW.amount = paid THEN 'paid'
      WHEN paid > 0 THEN 'partial'
      ELSE 'open'
    END;
  END IF;

  RETURN NEW;
END;
$$;

-- Tax on bills is treated as recoverable, so it reduces what is owed to the tax office.
CREATE OR REPLACE FUNCTION accounting.post_bill()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry_lines JSONB;
BEGIN
  IF NEW.status IN ('open', 'partial', 'paid') THEN
    SELECT jsonb_agg(line) || jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '2000'), 'credit', NEW.amount
      ) INTO entry_lines
      FROM (
        SELECT jsonb_build_object('account_id', l->>'account_id', 'debit', sum(round((l->>'amount')::numeric, 2))) AS line
        FROM jsonb_array_elements(NEW.line_items) l
        GROUP BY l->>'account_id'
      ) grouped;
    IF NEW.tax_amount > 0 THEN
      entry_lines := entry_lines || jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '2100'), 'debit', NEW.tax_amount
      );
    END IF;
  END IF;

  PERFORM accounting.sync_entry(
    NEW.tenant_id, 'bill', NEW.id, NEW.bill_date, 'Bill ' || NEW.bill_number, entry_lines
  );
  RETURN NEW;
END;
$$;

-- A credit note takes back the same share of tax as the invoice charged.
CREATE OR REPLACE FUNCTION accounting.create_credit_note(
  p_tenant UUID, p_invoice UUID, p_date DATE, p_amount NUMERIC, p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  amount NUMERIC := round(p_amount, 2);
  tax NUMERIC;
  next_number BIGINT;
  number_text TEXT;
  new_id UUID;
  entry_lines JSONB;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO invoice FROM accounting.invoices WHERE id = p_invoice AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF invoice.status NOT IN ('sent', 'partial') THEN
    RAISE EXCEPTION 'Credit notes need a sent invoice with a balance';
  END IF;
  IF coalesce(amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an amount';
  END IF;
  IF amount > invoice.amount - invoice.amount_paid - invoice.amount_credited THEN
    RAISE EXCEPTION 'That is more than the % still owed', invoice.amount - invoice.amount_paid - invoice.amount_credited;
  END IF;
  IF length(trim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  tax := round(amount * invoice.tax_amount / invoice.amount, 2);

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 2));
  SELECT coalesce(max(substring(credit_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
    FROM accounting.credit_notes WHERE tenant_id = p_tenant;
  number_text := 'CN-' || lpad(next_number::text, 4, '0');

  INSERT INTO accounting.credit_notes (tenant_id, invoice_id, credit_number, credit_date, amount, tax_amount, reason)
    VALUES (p_tenant, p_invoice, number_text, p_date, amount, tax, trim(p_reason))
    RETURNING id INTO new_id;

  entry_lines := jsonb_build_array(
    jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '1200'), 'credit', amount)
  );
  IF amount - tax > 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', accounting.account_by_code(p_tenant, '4000'), 'debit', amount - tax
    );
  END IF;
  IF tax > 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', accounting.account_by_code(p_tenant, '2100'), 'debit', tax
    );
  END IF;

  PERFORM accounting.insert_entry(
    p_tenant, p_date, 'Credit note ' || number_text || ' for ' || invoice.invoice_number, 'credit_note', new_id, NULL,
    entry_lines
  );

  UPDATE accounting.invoices SET updated_at = now() WHERE id = p_invoice;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.cash_flow(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH cash_entries AS (
    SELECT DISTINCT e.id
    FROM accounting.journal_entries e
    JOIN accounting.journal_lines l ON l.entry_id = e.id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE e.tenant_id = p_tenant AND a.is_cash AND e.entry_date BETWEEN p_from AND p_to
  ), rows AS (
    SELECT
      CASE
        WHEN a.type IN ('revenue', 'expense') OR a.code IN ('1200', '2000', '2100') THEN 'operating'
        WHEN a.type = 'asset' THEN 'investing'
        ELSE 'financing'
      END AS activity,
      a.code,
      CASE a.code
        WHEN '1200' THEN 'Received from customers'
        WHEN '2000' THEN 'Paid to vendors'
        ELSE a.name
      END AS name,
      sum(l.credit - l.debit) AS amount
    FROM accounting.journal_lines l
    JOIN cash_entries c ON c.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE NOT a.is_cash
    GROUP BY a.id
    HAVING sum(l.credit - l.debit) <> 0
  ), cash AS (
    SELECT
      coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < p_from), 0) AS opening,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date <= p_to), 0) AS closing
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND a.is_cash
  )
  SELECT json_build_object(
    'operating', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.activity = 'operating'), '[]'::json),
    'investing', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.activity = 'investing'), '[]'::json),
    'financing', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.activity = 'financing'), '[]'::json),
    'total_operating', (SELECT coalesce(sum(amount), 0) FROM rows WHERE activity = 'operating'),
    'total_investing', (SELECT coalesce(sum(amount), 0) FROM rows WHERE activity = 'investing'),
    'total_financing', (SELECT coalesce(sum(amount), 0) FROM rows WHERE activity = 'financing'),
    'net_change', (SELECT coalesce(sum(amount), 0) FROM rows),
    'opening', cash.opening,
    'closing', cash.closing
  ) FROM cash;
$$;

-- Everything on the tax account in the period, by where it came from.
CREATE FUNCTION accounting.tax_summary(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH lines AS (
    SELECT e.entry_date, e.source_type, l.credit - l.debit AS amount
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND a.code = '2100' AND e.entry_date <= p_to
  ), period AS (
    SELECT
      coalesce(sum(amount) FILTER (WHERE source_type IN ('invoice', 'credit_note')), 0) AS collected,
      coalesce(-sum(amount) FILTER (WHERE source_type = 'bill'), 0) AS on_purchases,
      coalesce(-sum(amount) FILTER (WHERE source_type NOT IN ('invoice', 'credit_note', 'bill')), 0) AS paid
    FROM lines WHERE entry_date >= p_from
  )
  SELECT json_build_object(
    'collected', period.collected,
    'on_purchases', period.on_purchases,
    'net', period.collected - period.on_purchases,
    'paid', period.paid,
    'balance', (SELECT coalesce(sum(amount), 0) FROM lines)
  ) FROM period;
$$;

CREATE FUNCTION accounting.require_bank_account(p_tenant UUID, p_account UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts WHERE id = p_account AND tenant_id = p_tenant AND is_cash
  ) THEN
    RAISE EXCEPTION 'Choose a cash or bank account';
  END IF;
END;
$$;

-- Importing the same statement twice adds nothing, even when it has identical lines.
CREATE FUNCTION accounting.import_bank_lines(p_tenant UUID, p_account UUID, p_lines JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  total INT;
  added INT;
BEGIN
  PERFORM accounting.require_bank_account(p_tenant, p_account);
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'The file has no lines to import';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    WHERE (l->>'line_date') !~ '^\d{4}-\d{2}-\d{2}$' OR (l->>'amount') IS NULL
      OR length(trim(coalesce(l->>'description', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'Every line needs a date, a description and an amount';
  END IF;

  total := jsonb_array_length(p_lines);

  WITH parsed AS (
    SELECT (l->>'line_date')::date AS line_date, trim(l->>'description') AS description,
      round((l->>'amount')::numeric, 2) AS amount
    FROM jsonb_array_elements(p_lines) l
  ), numbered AS (
    SELECT *, row_number() OVER (PARTITION BY line_date, amount, lower(description)) AS occurrence
    FROM parsed WHERE amount <> 0
  ), inserted AS (
    INSERT INTO accounting.bank_lines (tenant_id, account_id, line_date, description, amount, fingerprint)
      SELECT p_tenant, p_account, line_date, description, amount,
        md5(line_date || '|' || amount || '|' || lower(description) || '|' || occurrence)
      FROM numbered
      ON CONFLICT (tenant_id, account_id, fingerprint) DO NOTHING
      RETURNING 1
  )
  SELECT count(*) INTO added FROM inserted;

  RETURN json_build_object('imported', added, 'skipped', total - added);
END;
$$;

-- Unmatched lines come with the closest book line of the same amount within a week.
CREATE FUNCTION accounting.bank_feed(p_tenant UUID, p_account UUID)
RETURNS TABLE (
  id UUID, line_date DATE, description TEXT, amount NUMERIC, status TEXT, reconciled BOOLEAN,
  is_manual BOOLEAN, matched_memo TEXT, suggested_line_id UUID, suggested_memo TEXT, suggested_date DATE
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT b.id, b.line_date, b.description, b.amount, b.status, b.reconciliation_id IS NOT NULL,
    b.fingerprint LIKE 'manual:%', me.memo, s.line_id, s.memo, s.entry_date
  FROM accounting.bank_lines b
  LEFT JOIN accounting.journal_lines ml ON ml.id = b.journal_line_id
  LEFT JOIN accounting.journal_entries me ON me.id = ml.entry_id
  LEFT JOIN LATERAL (
    SELECT l.id AS line_id, e.memo, e.entry_date
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    WHERE b.status = 'unmatched' AND l.account_id = b.account_id
      AND l.debit - l.credit = b.amount
      AND abs(e.entry_date - b.line_date) <= 7
      AND NOT EXISTS (SELECT 1 FROM accounting.bank_lines used WHERE used.journal_line_id = l.id)
    ORDER BY abs(e.entry_date - b.line_date), e.entry_number
    LIMIT 1
  ) s ON true
  WHERE b.tenant_id = p_tenant AND b.account_id = p_account
    AND b.fingerprint NOT LIKE 'manual:%'
  ORDER BY b.status = 'unmatched' DESC, b.line_date DESC, b.id;
$$;

CREATE FUNCTION accounting.match_bank_line(p_tenant UUID, p_line UUID, p_journal_line UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  bank accounting.bank_lines;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO bank FROM accounting.bank_lines WHERE id = p_line AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF bank.status <> 'unmatched' THEN
    RAISE EXCEPTION 'This line has already been dealt with';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.journal_lines
    WHERE id = p_journal_line AND tenant_id = p_tenant AND account_id = bank.account_id
      AND debit - credit = bank.amount
  ) THEN
    RAISE EXCEPTION 'That entry is not for this account and amount';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting.bank_lines WHERE journal_line_id = p_journal_line) THEN
    RAISE EXCEPTION 'That entry is already matched';
  END IF;

  UPDATE accounting.bank_lines SET status = 'matched', journal_line_id = p_journal_line WHERE id = p_line;
END;
$$;

-- Posting a statement line records what the books missed, such as a bank fee.
CREATE FUNCTION accounting.post_bank_line(p_tenant UUID, p_line UUID, p_account UUID, p_memo TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  bank accounting.bank_lines;
  new_entry UUID;
  matched UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO bank FROM accounting.bank_lines WHERE id = p_line AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF bank.status <> 'unmatched' THEN
    RAISE EXCEPTION 'This line has already been dealt with';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts
    WHERE id = p_account AND tenant_id = p_tenant AND is_active
      AND id <> bank.account_id AND code NOT IN ('1200', '2000')
  ) THEN
    RAISE EXCEPTION 'Choose another account. Customer and vendor money should be matched to its payment.';
  END IF;

  new_entry := accounting.insert_entry(
    p_tenant, bank.line_date, coalesce(nullif(trim(p_memo), ''), bank.description), 'bank', p_line, NULL,
    jsonb_build_array(
      jsonb_build_object('account_id', bank.account_id, 'debit', greatest(bank.amount, 0), 'credit', greatest(-bank.amount, 0)),
      jsonb_build_object('account_id', p_account, 'debit', greatest(-bank.amount, 0), 'credit', greatest(bank.amount, 0))
    )
  );

  SELECT id INTO matched FROM accounting.journal_lines WHERE entry_id = new_entry AND account_id = bank.account_id;
  UPDATE accounting.bank_lines SET status = 'matched', journal_line_id = matched WHERE id = p_line;
  RETURN new_entry;
END;
$$;

CREATE FUNCTION accounting.unmatch_bank_line(p_tenant UUID, p_line UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  bank accounting.bank_lines;
  posted UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO bank FROM accounting.bank_lines WHERE id = p_line AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF bank.reconciliation_id IS NOT NULL THEN
    RAISE EXCEPTION 'This line is part of a finished reconciliation';
  END IF;

  IF bank.fingerprint LIKE 'manual:%' THEN
    DELETE FROM accounting.bank_lines WHERE id = p_line;
    RETURN;
  END IF;

  UPDATE accounting.bank_lines SET status = 'unmatched', journal_line_id = NULL WHERE id = p_line;

  SELECT e.id INTO posted FROM accounting.journal_entries e
    WHERE e.source_type = 'bank' AND e.source_id = p_line AND e.reversal_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM accounting.journal_entries r WHERE r.reversal_of = e.id);
  IF posted IS NOT NULL THEN
    PERFORM accounting.reverse_entry(posted);
  END IF;
END;
$$;

CREATE FUNCTION accounting.set_bank_line_ignored(p_tenant UUID, p_line UUID, p_ignored BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE accounting.bank_lines
    SET status = CASE WHEN p_ignored THEN 'ignored' ELSE 'unmatched' END
    WHERE id = p_line AND tenant_id = p_tenant AND status = CASE WHEN p_ignored THEN 'unmatched' ELSE 'ignored' END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This line has already been dealt with';
  END IF;
END;
$$;

-- For money that cleared without a statement line, such as an opening balance.
CREATE FUNCTION accounting.clear_book_line(p_tenant UUID, p_journal_line UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  line accounting.journal_lines;
  entry accounting.journal_entries;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO line FROM accounting.journal_lines WHERE id = p_journal_line AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  PERFORM accounting.require_bank_account(p_tenant, line.account_id);
  IF EXISTS (SELECT 1 FROM accounting.bank_lines WHERE journal_line_id = p_journal_line) THEN
    RAISE EXCEPTION 'That entry is already cleared';
  END IF;

  SELECT * INTO entry FROM accounting.journal_entries WHERE id = line.entry_id;
  INSERT INTO accounting.bank_lines
      (tenant_id, account_id, line_date, description, amount, fingerprint, status, journal_line_id)
    VALUES (p_tenant, line.account_id, entry.entry_date, entry.memo, line.debit - line.credit,
      'manual:' || p_journal_line, 'matched', p_journal_line);
END;
$$;

CREATE FUNCTION accounting.reconcile_status(p_tenant UUID, p_account UUID, p_as_of DATE)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH book AS (
    SELECT l.id, e.entry_number, e.entry_date, e.memo, l.debit - l.credit AS amount,
      b.id AS bank_line_id, b.id IS NOT NULL AS cleared, b.reconciliation_id IS NOT NULL AS reconciled
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    LEFT JOIN accounting.bank_lines b ON b.journal_line_id = l.id
    WHERE l.tenant_id = p_tenant AND l.account_id = p_account AND e.entry_date <= p_as_of
  )
  SELECT json_build_object(
    'book_balance', (SELECT coalesce(sum(amount), 0) FROM book),
    'cleared_balance', (SELECT coalesce(sum(amount), 0) FROM book WHERE cleared),
    'uncleared', coalesce((
      SELECT json_agg(u ORDER BY u.entry_date DESC, u.entry_number DESC)
      FROM (SELECT id, entry_number, entry_date, memo, amount FROM book WHERE NOT cleared) u
    ), '[]'::json),
    'cleared', coalesce((
      SELECT json_agg(c ORDER BY c.entry_date DESC, c.entry_number DESC)
      FROM (SELECT bank_line_id, entry_number, entry_date, memo, amount FROM book WHERE cleared AND NOT reconciled) c
    ), '[]'::json),
    'last_reconciled', (
      SELECT max(statement_date) FROM accounting.reconciliations
      WHERE tenant_id = p_tenant AND account_id = p_account
    )
  );
$$;

-- Finishing locks the cleared lines, so a reconciled month cannot quietly change.
CREATE FUNCTION accounting.finish_reconciliation(p_tenant UUID, p_account UUID, p_date DATE, p_balance NUMERIC)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  cleared NUMERIC;
  new_id UUID;
BEGIN
  PERFORM accounting.require_bank_account(p_tenant, p_account);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_account::text, 3));

  SELECT coalesce(sum(l.debit - l.credit), 0) INTO cleared
    FROM accounting.bank_lines b
    JOIN accounting.journal_lines l ON l.id = b.journal_line_id
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    WHERE b.account_id = p_account AND e.entry_date <= p_date;

  IF cleared <> round(p_balance, 2) THEN
    RAISE EXCEPTION 'Cleared items come to % but the statement says %', cleared, round(p_balance, 2);
  END IF;

  INSERT INTO accounting.reconciliations (tenant_id, account_id, statement_date, statement_balance)
    VALUES (p_tenant, p_account, p_date, round(p_balance, 2))
    RETURNING id INTO new_id;

  UPDATE accounting.bank_lines b SET reconciliation_id = new_id
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    WHERE l.id = b.journal_line_id AND b.account_id = p_account
      AND b.reconciliation_id IS NULL AND e.entry_date <= p_date;

  RETURN new_id;
END;
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA accounting FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.account_ledger(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.create_journal_entry(UUID, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.reverse_journal_entry(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.trial_balance(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.record_payment(UUID, UUID, UUID, UUID, DATE, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.void_payment(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.create_credit_note(UUID, UUID, DATE, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.void_credit_note(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.customer_list(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.vendor_list(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.profit_and_loss(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.balance_sheet(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.cash_flow(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.aged_balances(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.tax_summary(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.import_bank_lines(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.bank_feed(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.match_bank_line(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.post_bank_line(UUID, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.unmatch_bank_line(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.set_bank_line_ignored(UUID, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.clear_book_line(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.reconcile_status(UUID, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.finish_reconciliation(UUID, UUID, DATE, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';
