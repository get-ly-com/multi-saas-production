-- Run after supabase-migration-008.
-- Cost centers, budgets, fixed assets with depreciation, customer refunds and vendor credits.
ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note', 'bank', 'closing',
    'asset', 'depreciation', 'vendor_credit'
  ));

CREATE TABLE accounting.cost_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (length(trim(code)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, code)
);

ALTER TABLE accounting.journal_lines ADD COLUMN cost_center_id UUID REFERENCES accounting.cost_centers(id);
CREATE INDEX idx_lines_cost_center ON accounting.journal_lines(cost_center_id);
ALTER TABLE accounting.expenses ADD COLUMN cost_center_id UUID REFERENCES accounting.cost_centers(id);
CREATE INDEX idx_expenses_cost_center ON accounting.expenses(cost_center_id);
ALTER TABLE accounting.invoices ADD COLUMN cost_center_id UUID REFERENCES accounting.cost_centers(id);
CREATE INDEX idx_invoices_cost_center ON accounting.invoices(cost_center_id);

CREATE TABLE accounting.budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  fiscal_year INT NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, name, fiscal_year)
);

CREATE TABLE accounting.budget_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  budget_id UUID NOT NULL REFERENCES accounting.budgets(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  UNIQUE (budget_id, account_id, month)
);
CREATE INDEX idx_budget_lines_account ON accounting.budget_lines(account_id);
CREATE INDEX idx_budget_lines_tenant ON accounting.budget_lines(tenant_id);

CREATE TABLE accounting.fixed_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  asset_account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  accumulated_account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  expense_account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  cost NUMERIC(14, 2) NOT NULL CHECK (cost > 0),
  salvage NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (salvage >= 0),
  life_months INT NOT NULL CHECK (life_months > 0),
  start_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  disposed_on DATE,
  created_at TIMESTAMP DEFAULT now(),
  CHECK (salvage < cost)
);
CREATE INDEX idx_assets_tenant ON accounting.fixed_assets(tenant_id);
CREATE INDEX idx_assets_asset_account ON accounting.fixed_assets(asset_account_id);
CREATE INDEX idx_assets_accumulated_account ON accounting.fixed_assets(accumulated_account_id);
CREATE INDEX idx_assets_expense_account ON accounting.fixed_assets(expense_account_id);

CREATE TABLE accounting.depreciation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES accounting.fixed_assets(id) ON DELETE CASCADE,
  period DATE NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  entry_id UUID NOT NULL REFERENCES accounting.journal_entries(id),
  UNIQUE (asset_id, period)
);
CREATE INDEX idx_depreciation_entry ON accounting.depreciation_lines(entry_id);
CREATE INDEX idx_depreciation_tenant ON accounting.depreciation_lines(tenant_id);

ALTER TABLE accounting.credit_notes ADD COLUMN refund_account_id UUID REFERENCES accounting.accounts(id);
CREATE INDEX idx_credit_notes_refund_account ON accounting.credit_notes(refund_account_id);

CREATE TABLE accounting.vendor_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES accounting.bills(id),
  account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  credit_number TEXT NOT NULL,
  credit_date DATE NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  voided_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, credit_number)
);
CREATE INDEX idx_vendor_credits_bill ON accounting.vendor_credits(bill_id);
CREATE INDEX idx_vendor_credits_account ON accounting.vendor_credits(account_id);

ALTER TABLE accounting.cost_centers ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.depreciation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.vendor_credits ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'accounting.cost_centers', 'accounting.budgets', 'accounting.budget_lines',
    'accounting.fixed_assets', 'accounting.depreciation_lines', 'accounting.vendor_credits'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_rows ON %s FOR SELECT TO authenticated
         USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))',
      target
    );
    EXECUTE format('GRANT SELECT ON %s TO authenticated', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    'accounting.cost_centers', 'accounting.budgets', 'accounting.fixed_assets', 'accounting.vendor_credits'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION accounting.audit_row()',
      target
    );
  END LOOP;
END;
$$;

CREATE POLICY tenant_writes ON accounting.cost_centers FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid()) AND role <> 'viewer'))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid()) AND role <> 'viewer'));
GRANT INSERT (tenant_id, code, name) ON accounting.cost_centers TO authenticated;
GRANT UPDATE (name, is_active) ON accounting.cost_centers TO authenticated;

CREATE OR REPLACE FUNCTION accounting.seed_chart(p_tenant UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
  VALUES
    (p_tenant, '1000', 'Cash', 'asset', true, true),
    (p_tenant, '1200', 'Accounts Receivable', 'asset', true, false),
    (p_tenant, '1500', 'Fixed Assets', 'asset', true, false),
    (p_tenant, '1590', 'Accumulated Depreciation', 'asset', true, false),
    (p_tenant, '2000', 'Accounts Payable', 'liability', true, false),
    (p_tenant, '2100', 'Tax Payable', 'liability', true, false),
    (p_tenant, '3000', 'Owner''s Equity', 'equity', true, false),
    (p_tenant, '3100', 'Retained Earnings', 'equity', true, false),
    (p_tenant, '4000', 'Sales Revenue', 'revenue', true, false),
    (p_tenant, '5000', 'Cost of Goods Sold', 'expense', true, false),
    (p_tenant, '6000', 'General Expenses', 'expense', true, false),
    (p_tenant, '6100', 'Depreciation Expense', 'expense', true, false),
    (p_tenant, '7000', 'Gain or Loss on Disposal', 'expense', true, false)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$$;
SELECT accounting.seed_chart(id) FROM public.tenants;

CREATE OR REPLACE FUNCTION accounting.insert_entry(
  p_tenant UUID, p_date DATE, p_memo TEXT, p_source TEXT, p_source_id UUID, p_reversal_of UUID, p_lines JSONB
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  new_id UUID;
  next_number BIGINT;
  total_debit NUMERIC;
  total_credit NUMERIC;
  locked_through DATE;
BEGIN
  SELECT lock_date INTO locked_through FROM accounting.settings WHERE tenant_id = p_tenant;
  IF p_date <= locked_through THEN
    RAISE EXCEPTION 'The books are locked through %. Use a later date.', locked_through;
  END IF;

  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal entry needs at least two lines';
  END IF;

  SELECT
    coalesce(sum(round(coalesce((l->>'debit')::numeric, 0), 2)), 0),
    coalesce(sum(round(coalesce((l->>'credit')::numeric, 0), 2)), 0)
  INTO total_debit, total_credit
  FROM jsonb_array_elements(p_lines) l;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Debits (%) must equal credits (%)', total_debit, total_credit;
  END IF;
  IF total_debit = 0 THEN
    RAISE EXCEPTION 'A journal entry needs an amount';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.accounts a
      ON a.id = (l->>'account_id')::uuid AND a.tenant_id = p_tenant
    WHERE a.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.cost_centers c
      ON c.id = nullif(l->>'cost_center_id', '')::uuid AND c.tenant_id = p_tenant
    WHERE nullif(l->>'cost_center_id', '') IS NOT NULL AND c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cost center not found';
  END IF;

  -- Keeps entry numbers gap-free when two postings race
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 0));
  SELECT coalesce(max(entry_number), 0) + 1 INTO next_number
    FROM accounting.journal_entries WHERE tenant_id = p_tenant;

  INSERT INTO accounting.journal_entries
      (tenant_id, entry_number, entry_date, memo, source_type, source_id, reversal_of)
    VALUES (p_tenant, next_number, p_date, p_memo, p_source, p_source_id, p_reversal_of)
    RETURNING id INTO new_id;

  INSERT INTO accounting.journal_lines (tenant_id, entry_id, account_id, debit, credit, cost_center_id)
    SELECT p_tenant, new_id, (l->>'account_id')::uuid,
      round(coalesce((l->>'debit')::numeric, 0), 2),
      round(coalesce((l->>'credit')::numeric, 0), 2),
      nullif(l->>'cost_center_id', '')::uuid
    FROM jsonb_array_elements(p_lines) l;

  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.reverse_entry(p_entry UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry accounting.journal_entries;
  swapped JSONB;
  locked_through DATE;
BEGIN
  SELECT * INTO entry FROM accounting.journal_entries WHERE id = p_entry;
  SELECT lock_date INTO locked_through FROM accounting.settings WHERE tenant_id = entry.tenant_id;

  SELECT jsonb_agg(jsonb_build_object(
      'account_id', account_id, 'debit', credit, 'credit', debit, 'cost_center_id', cost_center_id
    ))
    INTO swapped
    FROM accounting.journal_lines WHERE entry_id = p_entry;

  RETURN accounting.insert_entry(
    entry.tenant_id, greatest(current_date, entry.entry_date, locked_through + 1),
    'Reversal of #' || entry.entry_number || ': ' || entry.memo,
    entry.source_type, entry.source_id, entry.id, swapped
  );
END;
$$;

CREATE OR REPLACE FUNCTION accounting.sync_entry(
  p_tenant UUID, p_source TEXT, p_source_id UUID, p_date DATE, p_memo TEXT, p_lines JSONB
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  active UUID;
  active_date DATE;
BEGIN
  SELECT e.id, e.entry_date INTO active, active_date
    FROM accounting.journal_entries e
    WHERE e.source_type = p_source AND e.source_id = p_source_id AND e.reversal_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM accounting.journal_entries r WHERE r.reversal_of = e.id);

  IF active IS NOT NULL THEN
    IF p_lines IS NOT NULL AND active_date = p_date AND NOT EXISTS (
      (SELECT account_id, debit, credit, cost_center_id FROM accounting.journal_lines WHERE entry_id = active
       EXCEPT
       SELECT (l->>'account_id')::uuid, coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0),
         nullif(l->>'cost_center_id', '')::uuid
       FROM jsonb_array_elements(p_lines) l)
      UNION ALL
      (SELECT (l->>'account_id')::uuid, coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0),
         nullif(l->>'cost_center_id', '')::uuid
       FROM jsonb_array_elements(p_lines) l
       EXCEPT
       SELECT account_id, debit, credit, cost_center_id FROM accounting.journal_lines WHERE entry_id = active)
    ) THEN
      RETURN;
    END IF;
    PERFORM accounting.reverse_entry(active);
  END IF;

  IF p_lines IS NOT NULL THEN
    PERFORM accounting.insert_entry(p_tenant, p_date, p_memo, p_source, p_source_id, NULL, p_lines);
  END IF;
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
      jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '4000'), 'credit', NEW.subtotal,
        'cost_center_id', NEW.cost_center_id
      )
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
        SELECT jsonb_build_object(
            'account_id', l->>'account_id',
            'debit', sum(round((l->>'amount')::numeric, 2)),
            'cost_center_id', nullif(l->>'cost_center_id', '')
          ) AS line
        FROM jsonb_array_elements(NEW.line_items) l
        GROUP BY l->>'account_id', nullif(l->>'cost_center_id', '')
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

CREATE OR REPLACE FUNCTION accounting.post_expense()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  row_data accounting.expenses;
  entry_lines JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := OLD;
  ELSE
    row_data := NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = row_data.tenant_id) THEN
    RETURN NULL;
  END IF;

  IF TG_OP <> 'DELETE' AND row_data.amount > 0 THEN
    entry_lines := jsonb_build_array(
      jsonb_build_object('account_id', row_data.account_id, 'debit', row_data.amount, 'cost_center_id', row_data.cost_center_id),
      jsonb_build_object('account_id', accounting.account_by_code(row_data.tenant_id, '1000'), 'credit', row_data.amount)
    );
  END IF;

  PERFORM accounting.sync_entry(
    row_data.tenant_id, 'expense', row_data.id, row_data.expense_date,
    'Expense: ' || coalesce(row_data.description, row_data.category, 'General'), entry_lines
  );
  RETURN NULL;
END;
$$;

-- A refund is a credit note paid out in cash, so it comes off what the customer has paid.
CREATE OR REPLACE FUNCTION accounting.prepare_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  paid NUMERIC;
  credited NUMERIC;
  refunded NUMERIC;
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
    SELECT coalesce(sum(amount), 0), coalesce(sum(amount) FILTER (WHERE refund_account_id IS NOT NULL), 0)
      INTO credited, refunded
      FROM accounting.credit_notes WHERE invoice_id = NEW.id AND voided_at IS NULL;
    paid := paid - refunded;
    IF paid < 0 THEN
      RAISE EXCEPTION 'Void this invoice''s refunds first';
    END IF;
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

-- A vendor credit settles a bill the same way a payment does, without cash moving.
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
      AND a.type IN ('expense', 'asset') AND a.code NOT IN ('1200', '1590') AND NOT a.is_cash
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

  SELECT
    coalesce((SELECT sum(amount) FROM accounting.payments WHERE bill_id = NEW.id AND voided_at IS NULL), 0)
    + coalesce((SELECT sum(amount) FROM accounting.vendor_credits WHERE bill_id = NEW.id AND voided_at IS NULL), 0)
  INTO paid;
  NEW.amount_paid := paid;

  IF NEW.status = 'void' THEN
    IF paid > 0 THEN
      RAISE EXCEPTION 'Void this bill''s payments and vendor credits first';
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

-- Shared by credit notes and refunds. Tax is taken back in the same share the invoice charged.
CREATE FUNCTION accounting.issue_credit(
  p_tenant UUID, p_invoice accounting.invoices, p_date DATE, p_amount NUMERIC, p_reason TEXT, p_refund_account UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tax NUMERIC := round(p_amount * p_invoice.tax_amount / p_invoice.amount, 2);
  next_number BIGINT;
  number_text TEXT;
  new_id UUID;
  entry_lines JSONB;
BEGIN
  IF length(trim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 2));
  SELECT coalesce(max(substring(credit_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
    FROM accounting.credit_notes WHERE tenant_id = p_tenant;
  number_text := 'CN-' || lpad(next_number::text, 4, '0');

  INSERT INTO accounting.credit_notes
      (tenant_id, invoice_id, credit_number, credit_date, amount, tax_amount, reason, refund_account_id)
    VALUES (p_tenant, p_invoice.id, number_text, p_date, p_amount, tax, trim(p_reason), p_refund_account)
    RETURNING id INTO new_id;

  entry_lines := jsonb_build_array(jsonb_build_object(
    'account_id', coalesce(p_refund_account, accounting.account_by_code(p_tenant, '1200')), 'credit', p_amount
  ));
  IF p_amount - tax > 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', accounting.account_by_code(p_tenant, '4000'), 'debit', p_amount - tax,
      'cost_center_id', p_invoice.cost_center_id
    );
  END IF;
  IF tax > 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', accounting.account_by_code(p_tenant, '2100'), 'debit', tax
    );
  END IF;

  PERFORM accounting.insert_entry(
    p_tenant, p_date,
    CASE WHEN p_refund_account IS NULL THEN 'Credit note ' ELSE 'Refund ' END
      || number_text || ' for ' || p_invoice.invoice_number,
    'credit_note', new_id, NULL, entry_lines
  );

  UPDATE accounting.invoices SET updated_at = now() WHERE id = p_invoice.id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.create_credit_note(
  p_tenant UUID, p_invoice UUID, p_date DATE, p_amount NUMERIC, p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  amount NUMERIC := round(p_amount, 2);
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

  RETURN accounting.issue_credit(p_tenant, invoice, p_date, amount, p_reason, NULL);
END;
$$;

CREATE FUNCTION accounting.create_refund(
  p_tenant UUID, p_invoice UUID, p_date DATE, p_amount NUMERIC, p_account UUID, p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  amount NUMERIC := round(p_amount, 2);
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO invoice FROM accounting.invoices WHERE id = p_invoice AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF coalesce(amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an amount';
  END IF;
  IF amount > invoice.amount_paid THEN
    RAISE EXCEPTION 'That is more than the % paid on this invoice', invoice.amount_paid;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active
  ) THEN
    RAISE EXCEPTION 'Choose a cash or bank account';
  END IF;

  RETURN accounting.issue_credit(p_tenant, invoice, p_date, amount, p_reason, p_account);
END;
$$;

CREATE FUNCTION accounting.create_vendor_credit(
  p_tenant UUID, p_bill UUID, p_date DATE, p_amount NUMERIC, p_account UUID, p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  bill accounting.bills;
  amount NUMERIC := round(p_amount, 2);
  next_number BIGINT;
  number_text TEXT;
  new_id UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO bill FROM accounting.bills WHERE id = p_bill AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF bill.status NOT IN ('open', 'partial') THEN
    RAISE EXCEPTION 'Vendor credits need an approved bill with a balance';
  END IF;
  IF coalesce(amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an amount';
  END IF;
  IF amount > bill.amount - bill.amount_paid THEN
    RAISE EXCEPTION 'That is more than the % still owed', bill.amount - bill.amount_paid;
  END IF;
  IF length(trim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts
    WHERE id = p_account AND tenant_id = p_tenant AND is_active
      AND type IN ('expense', 'asset') AND code NOT IN ('1200', '1590') AND NOT is_cash
  ) THEN
    RAISE EXCEPTION 'Choose an expense or asset account';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 4));
  SELECT coalesce(max(substring(credit_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
    FROM accounting.vendor_credits WHERE tenant_id = p_tenant;
  number_text := 'VC-' || lpad(next_number::text, 4, '0');

  INSERT INTO accounting.vendor_credits (tenant_id, bill_id, account_id, credit_number, credit_date, amount, reason)
    VALUES (p_tenant, p_bill, p_account, number_text, p_date, amount, trim(p_reason))
    RETURNING id INTO new_id;

  PERFORM accounting.insert_entry(
    p_tenant, p_date, 'Vendor credit ' || number_text || ' for ' || bill.bill_number, 'vendor_credit', new_id, NULL,
    jsonb_build_array(
      jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '2000'), 'debit', amount),
      jsonb_build_object('account_id', p_account, 'credit', amount)
    )
  );

  UPDATE accounting.bills SET updated_at = now() WHERE id = p_bill;
  RETURN new_id;
END;
$$;

CREATE FUNCTION accounting.void_vendor_credit(p_tenant UUID, p_credit UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  credit accounting.vendor_credits;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO credit FROM accounting.vendor_credits WHERE id = p_credit AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF credit.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'This vendor credit has already been voided';
  END IF;

  UPDATE accounting.vendor_credits SET voided_at = now() WHERE id = p_credit;
  PERFORM accounting.reverse_entry(id) FROM accounting.journal_entries
    WHERE source_type = 'vendor_credit' AND source_id = p_credit AND reversal_of IS NULL;

  UPDATE accounting.bills SET updated_at = now() WHERE id = credit.bill_id;
END;
$$;

-- Budgets
CREATE FUNCTION accounting.save_budget(p_tenant UUID, p_budget UUID, p_name TEXT, p_year INT, p_lines JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  saved UUID := p_budget;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.accounts a
      ON a.id::text = l->>'account_id' AND a.tenant_id = p_tenant AND a.type IN ('revenue', 'expense')
    WHERE a.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Budgets can only use revenue and expense accounts';
  END IF;

  IF saved IS NULL THEN
    INSERT INTO accounting.budgets (tenant_id, name, fiscal_year)
      VALUES (p_tenant, trim(p_name), p_year)
      RETURNING id INTO saved;
  ELSE
    UPDATE accounting.budgets SET name = trim(p_name), fiscal_year = p_year
      WHERE id = saved AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not found';
    END IF;
    DELETE FROM accounting.budget_lines WHERE budget_id = saved;
  END IF;

  INSERT INTO accounting.budget_lines (tenant_id, budget_id, account_id, month, amount)
    SELECT p_tenant, saved, (l->>'account_id')::uuid, (l->>'month')::int, round((l->>'amount')::numeric, 2)
    FROM jsonb_array_elements(p_lines) l
    WHERE (l->>'amount')::numeric > 0;

  RETURN saved;
END;
$$;

CREATE FUNCTION accounting.delete_budget(p_tenant UUID, p_budget UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  DELETE FROM accounting.budgets WHERE id = p_budget AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
END;
$$;

CREATE FUNCTION accounting.budget_vs_actual(p_tenant UUID, p_budget UUID, p_from_month INT, p_to_month INT)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH budget AS (
    SELECT * FROM accounting.budgets WHERE id = p_budget AND tenant_id = p_tenant
  ), planned AS (
    SELECT bl.account_id, sum(bl.amount) AS budgeted
    FROM accounting.budget_lines bl JOIN budget b ON b.id = bl.budget_id
    WHERE bl.month BETWEEN p_from_month AND p_to_month
    GROUP BY bl.account_id
  ), actual AS (
    SELECT a.id AS account_id,
      sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE l.debit - l.credit END) AS actual
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    JOIN budget b ON true
    WHERE l.tenant_id = p_tenant AND a.type IN ('revenue', 'expense') AND e.source_type <> 'closing'
      AND extract(year FROM e.entry_date) = b.fiscal_year
      AND extract(month FROM e.entry_date) BETWEEN p_from_month AND p_to_month
    GROUP BY a.id
  ), rows AS (
    SELECT a.id AS account_id, a.code, a.name, a.type,
      coalesce(p.budgeted, 0) AS budgeted,
      coalesce(x.actual, 0) AS actual,
      CASE WHEN a.type = 'revenue'
        THEN coalesce(x.actual, 0) - coalesce(p.budgeted, 0)
        ELSE coalesce(p.budgeted, 0) - coalesce(x.actual, 0)
      END AS variance
    FROM accounting.accounts a
    LEFT JOIN planned p ON p.account_id = a.id
    LEFT JOIN actual x ON x.account_id = a.id
    WHERE a.tenant_id = p_tenant AND a.type IN ('revenue', 'expense')
      AND (p.account_id IS NOT NULL OR x.account_id IS NOT NULL)
  )
  SELECT json_build_object(
    'rows', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r), '[]'::json),
    'total_variance', (SELECT coalesce(sum(variance), 0) FROM rows)
  );
$$;

CREATE FUNCTION accounting.pl_by_cost_center(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS TABLE (cost_center_id UUID, code TEXT, name TEXT, revenue NUMERIC, expenses NUMERIC, net NUMERIC)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT c.id, coalesce(c.code, '—'), coalesce(c.name, 'Unassigned'),
    coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type = 'revenue'), 0),
    coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0),
    coalesce(sum(l.credit - l.debit), 0)
  FROM accounting.journal_lines l
  JOIN accounting.journal_entries e ON e.id = l.entry_id
  JOIN accounting.accounts a ON a.id = l.account_id
  LEFT JOIN accounting.cost_centers c ON c.id = l.cost_center_id
  WHERE l.tenant_id = p_tenant AND a.type IN ('revenue', 'expense')
    AND e.entry_date BETWEEN p_from AND p_to AND e.source_type <> 'closing'
  GROUP BY c.id, c.code, c.name
  ORDER BY c.code NULLS LAST;
$$;

-- Fixed assets. Registering can record the purchase, or the purchase may already be on a bill.
CREATE FUNCTION accounting.register_asset(
  p_tenant UUID, p_name TEXT, p_cost NUMERIC, p_salvage NUMERIC, p_life_months INT, p_start DATE, p_paid_from UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  asset_account UUID := accounting.account_by_code(p_tenant, '1500');
  new_id UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  INSERT INTO accounting.fixed_assets
      (tenant_id, name, asset_account_id, accumulated_account_id, expense_account_id, cost, salvage, life_months, start_date)
    VALUES (
      p_tenant, trim(p_name), asset_account, accounting.account_by_code(p_tenant, '1590'),
      accounting.account_by_code(p_tenant, '6100'), round(p_cost, 2), round(coalesce(p_salvage, 0), 2), p_life_months, p_start
    )
    RETURNING id INTO new_id;

  IF p_paid_from IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM accounting.accounts WHERE id = p_paid_from AND tenant_id = p_tenant AND is_cash AND is_active
    ) THEN
      RAISE EXCEPTION 'Choose a cash or bank account';
    END IF;
    PERFORM accounting.insert_entry(
      p_tenant, p_start, 'Purchase of ' || trim(p_name), 'asset', new_id, NULL,
      jsonb_build_array(
        jsonb_build_object('account_id', asset_account, 'debit', round(p_cost, 2)),
        jsonb_build_object('account_id', p_paid_from, 'credit', round(p_cost, 2))
      )
    );
  END IF;

  RETURN new_id;
END;
$$;

-- Straight-line by month. Running it twice adds nothing, and the last month takes any rounding.
CREATE FUNCTION accounting.run_depreciation(p_tenant UUID, p_through DATE)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  first_month DATE;
  this_month DATE;
  month_end DATE;
  asset accounting.fixed_assets;
  booked NUMERIC;
  months_done INT;
  base NUMERIC;
  charge NUMERIC;
  entry_lines JSONB;
  charges JSONB;
  new_entry UUID;
  posted INT := 0;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_through IS NULL THEN
    RAISE EXCEPTION 'Choose a date';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 5));

  SELECT min(date_trunc('month', start_date)::date) INTO first_month
    FROM accounting.fixed_assets WHERE tenant_id = p_tenant AND status = 'active';
  IF first_month IS NULL THEN
    RETURN 0;
  END IF;

  this_month := first_month;
  LOOP
    month_end := (this_month + interval '1 month' - interval '1 day')::date;
    EXIT WHEN month_end > p_through;

    entry_lines := '[]'::jsonb;
    charges := '[]'::jsonb;

    FOR asset IN
      SELECT a.* FROM accounting.fixed_assets a
      WHERE a.tenant_id = p_tenant AND a.status = 'active'
        AND date_trunc('month', a.start_date)::date <= this_month
        AND NOT EXISTS (SELECT 1 FROM accounting.depreciation_lines d WHERE d.asset_id = a.id AND d.period = this_month)
    LOOP
      SELECT coalesce(sum(amount), 0), count(*) INTO booked, months_done
        FROM accounting.depreciation_lines WHERE asset_id = asset.id;
      base := asset.cost - asset.salvage;
      charge := CASE WHEN months_done + 1 >= asset.life_months
        THEN base - booked
        ELSE least(round(base / asset.life_months, 2), base - booked)
      END;

      IF charge > 0 THEN
        entry_lines := entry_lines
          || jsonb_build_object('account_id', asset.expense_account_id, 'debit', charge)
          || jsonb_build_object('account_id', asset.accumulated_account_id, 'credit', charge);
        charges := charges || jsonb_build_object('asset_id', asset.id, 'amount', charge);
      END IF;
    END LOOP;

    IF jsonb_array_length(charges) > 0 THEN
      new_entry := accounting.insert_entry(
        p_tenant, month_end, 'Depreciation for ' || to_char(this_month, 'Mon YYYY'), 'depreciation', NULL, NULL, entry_lines
      );
      INSERT INTO accounting.depreciation_lines (tenant_id, asset_id, period, amount, entry_id)
        SELECT p_tenant, (c->>'asset_id')::uuid, this_month, (c->>'amount')::numeric, new_entry
        FROM jsonb_array_elements(charges) c;
      posted := posted + 1;
    END IF;

    this_month := (this_month + interval '1 month')::date;
  END LOOP;

  RETURN posted;
END;
$$;

CREATE FUNCTION accounting.dispose_asset(
  p_tenant UUID, p_asset UUID, p_date DATE, p_proceeds NUMERIC, p_account UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  asset accounting.fixed_assets;
  accumulated NUMERIC;
  proceeds NUMERIC := round(coalesce(p_proceeds, 0), 2);
  loss NUMERIC;
  entry_lines JSONB;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO asset FROM accounting.fixed_assets WHERE id = p_asset AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF asset.status <> 'active' THEN
    RAISE EXCEPTION 'This asset has already been disposed of';
  END IF;
  IF proceeds < 0 THEN
    RAISE EXCEPTION 'Enter a valid amount';
  END IF;
  IF proceeds > 0 AND NOT EXISTS (
    SELECT 1 FROM accounting.accounts WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active
  ) THEN
    RAISE EXCEPTION 'Choose a cash or bank account';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO accumulated FROM accounting.depreciation_lines WHERE asset_id = p_asset;
  loss := asset.cost - accumulated - proceeds;

  entry_lines := jsonb_build_array(jsonb_build_object('account_id', asset.asset_account_id, 'credit', asset.cost));
  IF accumulated > 0 THEN
    entry_lines := entry_lines || jsonb_build_object('account_id', asset.accumulated_account_id, 'debit', accumulated);
  END IF;
  IF proceeds > 0 THEN
    entry_lines := entry_lines || jsonb_build_object('account_id', p_account, 'debit', proceeds);
  END IF;
  IF loss <> 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', accounting.account_by_code(p_tenant, '7000'),
      'debit', greatest(loss, 0), 'credit', greatest(-loss, 0)
    );
  END IF;

  UPDATE accounting.fixed_assets SET status = 'disposed', disposed_on = p_date WHERE id = p_asset;
  RETURN accounting.insert_entry(p_tenant, p_date, 'Disposal of ' || asset.name, 'asset', p_asset, NULL, entry_lines);
END;
$$;

CREATE FUNCTION accounting.asset_register(p_tenant UUID)
RETURNS TABLE (
  id UUID, name TEXT, cost NUMERIC, salvage NUMERIC, life_months INT, start_date DATE, status TEXT,
  disposed_on DATE, accumulated NUMERIC, book_value NUMERIC
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT a.id, a.name, a.cost, a.salvage, a.life_months, a.start_date, a.status, a.disposed_on,
    coalesce(sum(d.amount), 0),
    CASE WHEN a.status = 'disposed' THEN 0 ELSE a.cost - coalesce(sum(d.amount), 0) END
  FROM accounting.fixed_assets a
  LEFT JOIN accounting.depreciation_lines d ON d.asset_id = a.id
  WHERE a.tenant_id = p_tenant
  GROUP BY a.id
  ORDER BY a.status, a.start_date DESC, a.name;
$$;

REVOKE EXECUTE ON FUNCTION
  accounting.issue_credit(UUID, accounting.invoices, DATE, NUMERIC, TEXT, UUID),
  accounting.create_refund(UUID, UUID, DATE, NUMERIC, UUID, TEXT),
  accounting.create_vendor_credit(UUID, UUID, DATE, NUMERIC, UUID, TEXT),
  accounting.void_vendor_credit(UUID, UUID),
  accounting.save_budget(UUID, UUID, TEXT, INT, JSONB),
  accounting.delete_budget(UUID, UUID),
  accounting.budget_vs_actual(UUID, UUID, INT, INT),
  accounting.pl_by_cost_center(UUID, DATE, DATE),
  accounting.register_asset(UUID, TEXT, NUMERIC, NUMERIC, INT, DATE, UUID),
  accounting.run_depreciation(UUID, DATE),
  accounting.dispose_asset(UUID, UUID, DATE, NUMERIC, UUID),
  accounting.asset_register(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  accounting.create_refund(UUID, UUID, DATE, NUMERIC, UUID, TEXT),
  accounting.create_vendor_credit(UUID, UUID, DATE, NUMERIC, UUID, TEXT),
  accounting.void_vendor_credit(UUID, UUID),
  accounting.save_budget(UUID, UUID, TEXT, INT, JSONB),
  accounting.delete_budget(UUID, UUID),
  accounting.budget_vs_actual(UUID, UUID, INT, INT),
  accounting.pl_by_cost_center(UUID, DATE, DATE),
  accounting.register_asset(UUID, TEXT, NUMERIC, NUMERIC, INT, DATE, UUID),
  accounting.run_depreciation(UUID, DATE),
  accounting.dispose_asset(UUID, UUID, DATE, NUMERIC, UUID),
  accounting.asset_register(UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
