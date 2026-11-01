-- Run after supabase-migration-009.
-- Invoices and bills in foreign currencies. The ledger always stays in the base currency.
-- base_amount is what a document posted to the ledger, and base_settled is how much of that has cleared,
-- so the difference always equals Accounts Receivable or Payable exactly.
ALTER TABLE accounting.settings ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'USD' CHECK (base_currency ~ '^[A-Z]{3}$');

CREATE TABLE accounting.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_date DATE NOT NULL,
  rate NUMERIC(18, 8) NOT NULL CHECK (rate > 0),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, currency, rate_date)
);
ALTER TABLE accounting.exchange_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON accounting.exchange_rates FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
GRANT SELECT ON accounting.exchange_rates TO authenticated;
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON accounting.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION accounting.audit_row();

ALTER TABLE accounting.invoices
  ADD COLUMN currency TEXT,
  ADD COLUMN exchange_rate NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  ADD COLUMN base_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN base_settled NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE accounting.bills
  ADD COLUMN currency TEXT,
  ADD COLUMN exchange_rate NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  ADD COLUMN base_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN base_settled NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE accounting.payments
  ADD COLUMN exchange_rate NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  ADD COLUMN base_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN control_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE accounting.credit_notes ADD COLUMN base_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE accounting.vendor_credits ADD COLUMN base_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;

UPDATE accounting.payments SET base_amount = amount, control_amount = amount;
UPDATE accounting.credit_notes SET base_amount = amount;
UPDATE accounting.vendor_credits SET base_amount = amount;

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
    (p_tenant, '7000', 'Gain or Loss on Disposal', 'expense', true, false),
    (p_tenant, '7100', 'Exchange Gain or Loss', 'expense', true, false)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$$;
SELECT accounting.seed_chart(id) FROM public.tenants;

CREATE FUNCTION accounting.base_currency(p_tenant UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT base_currency FROM accounting.settings WHERE tenant_id = p_tenant), 'USD');
$$;

CREATE OR REPLACE FUNCTION accounting.prepare_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  home TEXT := accounting.base_currency(NEW.tenant_id);
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

  NEW.currency := upper(coalesce(NEW.currency, home));
  IF NEW.currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three-letter currency code';
  END IF;
  IF NEW.currency = home THEN
    NEW.exchange_rate := 1;
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
  NEW.base_amount := round(NEW.subtotal * NEW.exchange_rate, 2) + round(NEW.tax_amount * NEW.exchange_rate, 2);

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'draft';
    NEW.amount_paid := 0;
    NEW.amount_credited := 0;
    NEW.base_settled := 0;
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

    IF (paid > 0 OR credited > 0)
       AND (NEW.currency <> OLD.currency OR NEW.exchange_rate <> OLD.exchange_rate) THEN
      RAISE EXCEPTION 'The currency and rate cannot change once money has been recorded against this invoice';
    END IF;

    SELECT
      coalesce((SELECT sum(control_amount) FROM accounting.payments WHERE invoice_id = NEW.id AND voided_at IS NULL), 0)
      + coalesce((SELECT sum(base_amount) FROM accounting.credit_notes
                  WHERE invoice_id = NEW.id AND voided_at IS NULL AND refund_account_id IS NULL), 0)
    INTO NEW.base_settled;

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

CREATE OR REPLACE FUNCTION accounting.post_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry_lines JSONB;
  tax_base NUMERIC := round(NEW.tax_amount * NEW.exchange_rate, 2);
BEGIN
  IF NEW.status IN ('sent', 'partial', 'paid') AND NEW.base_amount > 0 THEN
    entry_lines := jsonb_build_array(
      jsonb_build_object('account_id', accounting.account_by_code(NEW.tenant_id, '1200'), 'debit', NEW.base_amount),
      jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '4000'), 'credit', NEW.base_amount - tax_base,
        'cost_center_id', NEW.cost_center_id
      )
    );
    IF tax_base > 0 THEN
      entry_lines := entry_lines || jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '2100'), 'credit', tax_base
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
  home TEXT := accounting.base_currency(NEW.tenant_id);
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

  NEW.currency := upper(coalesce(NEW.currency, home));
  IF NEW.currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three-letter currency code';
  END IF;
  IF NEW.currency = home THEN
    NEW.exchange_rate := 1;
  END IF;

  SELECT sum(base), sum(round(base * coalesce(rate, 0) / 100, 2))
  INTO NEW.subtotal, NEW.tax_amount
  FROM (
    SELECT round((l->>'amount')::numeric, 2) AS base, t.rate
    FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id'
  ) lines;
  NEW.amount := NEW.subtotal + NEW.tax_amount;

  -- Rounded the same way post_bill groups the debits, so the entry always balances
  SELECT coalesce(sum(round(net * NEW.exchange_rate, 2)), 0) + round(NEW.tax_amount * NEW.exchange_rate, 2)
    INTO NEW.base_amount
    FROM (
      SELECT sum(round((l->>'amount')::numeric, 2)) AS net
      FROM jsonb_array_elements(NEW.line_items) l
      GROUP BY l->>'account_id', nullif(l->>'cost_center_id', '')
    ) grouped;

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
    NEW.base_settled := 0;
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
    + coalesce((SELECT sum(amount) FROM accounting.vendor_credits WHERE bill_id = NEW.id AND voided_at IS NULL), 0),
    coalesce((SELECT sum(control_amount) FROM accounting.payments WHERE bill_id = NEW.id AND voided_at IS NULL), 0)
    + coalesce((SELECT sum(base_amount) FROM accounting.vendor_credits WHERE bill_id = NEW.id AND voided_at IS NULL), 0)
  INTO paid, NEW.base_settled;

  IF paid > 0 AND (NEW.currency <> OLD.currency OR NEW.exchange_rate <> OLD.exchange_rate) THEN
    RAISE EXCEPTION 'The currency and rate cannot change once money has been recorded against this bill';
  END IF;
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

CREATE OR REPLACE FUNCTION accounting.post_bill()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry_lines JSONB;
  tax_base NUMERIC := round(NEW.tax_amount * NEW.exchange_rate, 2);
BEGIN
  IF NEW.status IN ('open', 'partial', 'paid') THEN
    SELECT jsonb_agg(line) || jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '2000'), 'credit', NEW.base_amount
      ) INTO entry_lines
      FROM (
        SELECT jsonb_build_object(
            'account_id', l->>'account_id',
            'debit', round(sum(round((l->>'amount')::numeric, 2)) * NEW.exchange_rate, 2),
            'cost_center_id', nullif(l->>'cost_center_id', '')
          ) AS line
        FROM jsonb_array_elements(NEW.line_items) l
        GROUP BY l->>'account_id', nullif(l->>'cost_center_id', '')
      ) grouped;
    IF tax_base > 0 THEN
      entry_lines := entry_lines || jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '2100'), 'debit', tax_base
      );
    END IF;
  END IF;

  PERFORM accounting.sync_entry(
    NEW.tenant_id, 'bill', NEW.id, NEW.bill_date, 'Bill ' || NEW.bill_number, entry_lines
  );
  RETURN NEW;
END;
$$;

-- The last settlement clears whatever is left in the base currency, so no cents get stranded.
CREATE FUNCTION accounting.settle_amount(p_amount NUMERIC, p_balance NUMERIC, p_rate NUMERIC, p_base_open NUMERIC)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN p_amount >= p_balance THEN p_base_open ELSE round(p_amount * p_rate, 2) END;
$$;

DROP FUNCTION accounting.record_payment(UUID, UUID, UUID, UUID, DATE, NUMERIC, TEXT);

-- Locking the document stops two payments from overpaying it.
CREATE FUNCTION accounting.record_payment(
  p_tenant UUID, p_invoice UUID, p_bill UUID, p_account UUID, p_date DATE, p_amount NUMERIC, p_reference TEXT, p_rate NUMERIC DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  bill accounting.bills;
  doc_label TEXT;
  doc_status TEXT;
  doc_currency TEXT;
  balance NUMERIC;
  control_base NUMERIC;
  amount NUMERIC := round(p_amount, 2);
  rate NUMERIC;
  cash_base NUMERIC;
  gain NUMERIC;
  new_id UUID;
  control UUID;
  entry_lines JSONB;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF num_nonnulls(p_invoice, p_bill) <> 1 THEN
    RAISE EXCEPTION 'Choose an invoice or a bill';
  END IF;
  IF coalesce(amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an amount';
  END IF;

  IF p_invoice IS NOT NULL THEN
    SELECT * INTO invoice FROM accounting.invoices WHERE id = p_invoice AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not found';
    END IF;
    doc_label := invoice.invoice_number;
    doc_status := invoice.status;
    doc_currency := invoice.currency;
    balance := invoice.amount - invoice.amount_paid - invoice.amount_credited;
    control_base := accounting.settle_amount(amount, balance, invoice.exchange_rate, invoice.base_amount - invoice.base_settled);
    control := accounting.account_by_code(p_tenant, '1200');
  ELSE
    SELECT * INTO bill FROM accounting.bills WHERE id = p_bill AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not found';
    END IF;
    doc_label := bill.bill_number;
    doc_status := bill.status;
    doc_currency := bill.currency;
    balance := bill.amount - bill.amount_paid;
    control_base := accounting.settle_amount(amount, balance, bill.exchange_rate, bill.base_amount - bill.base_settled);
    control := accounting.account_by_code(p_tenant, '2000');
  END IF;

  IF doc_status NOT IN ('sent', 'open', 'partial') THEN
    RAISE EXCEPTION 'Only sent or approved documents with a balance can be paid';
  END IF;
  IF amount > balance THEN
    RAISE EXCEPTION 'That is more than the % still owed', balance;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts
    WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active
  ) THEN
    RAISE EXCEPTION 'Choose a cash or bank account';
  END IF;

  IF doc_currency = accounting.base_currency(p_tenant) THEN
    rate := 1;
  ELSIF coalesce(p_rate, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter the exchange rate on the payment date';
  ELSE
    rate := p_rate;
  END IF;
  cash_base := round(amount * rate, 2);

  INSERT INTO accounting.payments
      (tenant_id, invoice_id, bill_id, account_id, payment_date, amount, reference, exchange_rate, base_amount, control_amount)
    VALUES (p_tenant, p_invoice, p_bill, p_account, p_date, amount, nullif(trim(p_reference), ''), rate, cash_base, control_base)
    RETURNING id INTO new_id;

  IF p_invoice IS NOT NULL THEN
    gain := cash_base - control_base;
    entry_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_account, 'debit', cash_base),
      jsonb_build_object('account_id', control, 'credit', control_base)
    );
  ELSE
    gain := control_base - cash_base;
    entry_lines := jsonb_build_array(
      jsonb_build_object('account_id', control, 'debit', control_base),
      jsonb_build_object('account_id', p_account, 'credit', cash_base)
    );
  END IF;
  IF gain <> 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', accounting.account_by_code(p_tenant, '7100'),
      'debit', greatest(-gain, 0), 'credit', greatest(gain, 0)
    );
  END IF;

  PERFORM accounting.insert_entry(
    p_tenant, p_date, 'Payment for ' || doc_label, 'payment', new_id, NULL, entry_lines
  );

  UPDATE accounting.invoices SET updated_at = now() WHERE id = p_invoice;
  UPDATE accounting.bills SET updated_at = now() WHERE id = p_bill;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.issue_credit(
  p_tenant UUID, p_invoice accounting.invoices, p_date DATE, p_amount NUMERIC, p_reason TEXT, p_refund_account UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tax NUMERIC := round(p_amount * p_invoice.tax_amount / p_invoice.amount, 2);
  gross NUMERIC;
  tax_base NUMERIC;
  next_number BIGINT;
  number_text TEXT;
  new_id UUID;
  entry_lines JSONB;
BEGIN
  IF length(trim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  gross := CASE WHEN p_refund_account IS NOT NULL
    THEN round(p_amount * p_invoice.exchange_rate, 2)
    ELSE accounting.settle_amount(
      p_amount, p_invoice.amount - p_invoice.amount_paid - p_invoice.amount_credited,
      p_invoice.exchange_rate, p_invoice.base_amount - p_invoice.base_settled
    )
  END;
  tax_base := least(round(tax * p_invoice.exchange_rate, 2), gross);

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 2));
  SELECT coalesce(max(substring(credit_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
    FROM accounting.credit_notes WHERE tenant_id = p_tenant;
  number_text := 'CN-' || lpad(next_number::text, 4, '0');

  INSERT INTO accounting.credit_notes
      (tenant_id, invoice_id, credit_number, credit_date, amount, tax_amount, reason, refund_account_id, base_amount)
    VALUES (p_tenant, p_invoice.id, number_text, p_date, p_amount, tax, trim(p_reason), p_refund_account, gross)
    RETURNING id INTO new_id;

  entry_lines := jsonb_build_array(jsonb_build_object(
    'account_id', coalesce(p_refund_account, accounting.account_by_code(p_tenant, '1200')), 'credit', gross
  ));
  IF gross - tax_base > 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', accounting.account_by_code(p_tenant, '4000'), 'debit', gross - tax_base,
      'cost_center_id', p_invoice.cost_center_id
    );
  END IF;
  IF tax_base > 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', accounting.account_by_code(p_tenant, '2100'), 'debit', tax_base
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

CREATE OR REPLACE FUNCTION accounting.create_vendor_credit(
  p_tenant UUID, p_bill UUID, p_date DATE, p_amount NUMERIC, p_account UUID, p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  bill accounting.bills;
  amount NUMERIC := round(p_amount, 2);
  control_base NUMERIC;
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

  control_base := accounting.settle_amount(
    amount, bill.amount - bill.amount_paid, bill.exchange_rate, bill.base_amount - bill.base_settled
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 4));
  SELECT coalesce(max(substring(credit_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
    FROM accounting.vendor_credits WHERE tenant_id = p_tenant;
  number_text := 'VC-' || lpad(next_number::text, 4, '0');

  INSERT INTO accounting.vendor_credits
      (tenant_id, bill_id, account_id, credit_number, credit_date, amount, reason, base_amount)
    VALUES (p_tenant, p_bill, p_account, number_text, p_date, amount, trim(p_reason), control_base)
    RETURNING id INTO new_id;

  PERFORM accounting.insert_entry(
    p_tenant, p_date, 'Vendor credit ' || number_text || ' for ' || bill.bill_number, 'vendor_credit', new_id, NULL,
    jsonb_build_array(
      jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '2000'), 'debit', control_base),
      jsonb_build_object('account_id', p_account, 'credit', control_base)
    )
  );

  UPDATE accounting.bills SET updated_at = now() WHERE id = p_bill;
  RETURN new_id;
END;
$$;

-- Balance reports add up the base currency, because foreign amounts cannot be summed.
CREATE OR REPLACE FUNCTION accounting.customer_list(p_tenant UUID)
RETURNS TABLE (
  id UUID, name TEXT, email TEXT, phone TEXT, address TEXT, is_active BOOLEAN, balance NUMERIC
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT c.id, c.name, c.email, c.phone, c.address, c.is_active,
    coalesce(sum(i.base_amount - i.base_settled), 0)
  FROM accounting.customers c
  LEFT JOIN accounting.invoices i ON i.customer_id = c.id AND i.status IN ('sent', 'partial')
  WHERE c.tenant_id = p_tenant
  GROUP BY c.id
  ORDER BY c.name;
$$;

CREATE OR REPLACE FUNCTION accounting.vendor_list(p_tenant UUID)
RETURNS TABLE (
  id UUID, name TEXT, email TEXT, phone TEXT, address TEXT, is_active BOOLEAN, balance NUMERIC
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT v.id, v.name, v.email, v.phone, v.address, v.is_active,
    coalesce(sum(b.base_amount - b.base_settled), 0)
  FROM accounting.vendors v
  LEFT JOIN accounting.bills b ON b.vendor_id = v.id AND b.status IN ('open', 'partial')
  WHERE v.tenant_id = p_tenant
  GROUP BY v.id
  ORDER BY v.name;
$$;

CREATE OR REPLACE FUNCTION accounting.summary(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH books AS (
    SELECT
      coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type = 'revenue'), 0) AS revenue,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0) AS expenses
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND e.source_type <> 'closing'
  ), inv AS (
    SELECT
      coalesce(sum(base_amount - base_settled) FILTER (WHERE status IN ('sent', 'partial')), 0) AS outstanding,
      coalesce(sum(base_amount - base_settled)
        FILTER (WHERE status IN ('sent', 'partial') AND due_date < current_date), 0) AS overdue,
      count(*) AS invoice_count
    FROM accounting.invoices WHERE tenant_id = p_tenant
  ), bil AS (
    SELECT coalesce(sum(base_amount - base_settled) FILTER (WHERE status IN ('open', 'partial')), 0) AS payables
    FROM accounting.bills WHERE tenant_id = p_tenant
  ), exp AS (
    SELECT count(*) AS expense_count FROM accounting.expenses WHERE tenant_id = p_tenant
  )
  SELECT json_build_object(
    'revenue', books.revenue,
    'outstanding', inv.outstanding,
    'overdue', inv.overdue,
    'payables', bil.payables,
    'totalExpenses', books.expenses,
    'netProfit', books.revenue - books.expenses,
    'invoiceCount', inv.invoice_count,
    'expenseCount', exp.expense_count
  ) FROM books, inv, bil, exp;
$$;

CREATE OR REPLACE FUNCTION accounting.aged_balances(p_tenant UUID, p_kind TEXT)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH docs AS (
    SELECT c.id AS party_id, c.name,
      i.base_amount - i.base_settled AS balance,
      current_date - coalesce(i.due_date, i.invoice_date) AS days
    FROM accounting.invoices i
    JOIN accounting.customers c ON c.id = i.customer_id
    WHERE p_kind = 'receivable' AND i.tenant_id = p_tenant AND i.status IN ('sent', 'partial')
    UNION ALL
    SELECT v.id, v.name,
      b.base_amount - b.base_settled,
      current_date - coalesce(b.due_date, b.bill_date)
    FROM accounting.bills b
    JOIN accounting.vendors v ON v.id = b.vendor_id
    WHERE p_kind = 'payable' AND b.tenant_id = p_tenant AND b.status IN ('open', 'partial')
  ), rows AS (
    SELECT party_id, name,
      coalesce(sum(balance) FILTER (WHERE days <= 0), 0) AS not_due,
      coalesce(sum(balance) FILTER (WHERE days BETWEEN 1 AND 30), 0) AS days_1_30,
      coalesce(sum(balance) FILTER (WHERE days BETWEEN 31 AND 60), 0) AS days_31_60,
      coalesce(sum(balance) FILTER (WHERE days BETWEEN 61 AND 90), 0) AS days_61_90,
      coalesce(sum(balance) FILTER (WHERE days > 90), 0) AS days_over_90,
      sum(balance) AS total
    FROM docs
    GROUP BY party_id, name
  )
  SELECT json_build_object(
    'rows', coalesce((SELECT json_agg(r ORDER BY r.name) FROM rows r), '[]'::json),
    'totals', (SELECT json_build_object(
      'not_due', coalesce(sum(not_due), 0),
      'days_1_30', coalesce(sum(days_1_30), 0),
      'days_31_60', coalesce(sum(days_31_60), 0),
      'days_61_90', coalesce(sum(days_61_90), 0),
      'days_over_90', coalesce(sum(days_over_90), 0),
      'total', coalesce(sum(total), 0)
    ) FROM rows)
  );
$$;

CREATE FUNCTION accounting.currency_overview(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT json_build_object(
    'base', accounting.base_currency(p_tenant),
    'can_change_base', NOT EXISTS (SELECT 1 FROM accounting.journal_entries WHERE tenant_id = p_tenant),
    'rates', coalesce((
      SELECT json_agg(r ORDER BY r.currency)
      FROM (
        SELECT DISTINCT ON (currency) currency, rate, rate_date
        FROM accounting.exchange_rates WHERE tenant_id = p_tenant
        ORDER BY currency, rate_date DESC
      ) r
    ), '[]'::json)
  );
$$;

CREATE FUNCTION accounting.save_exchange_rate(p_tenant UUID, p_currency TEXT, p_date DATE, p_rate NUMERIC)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  code TEXT := upper(trim(coalesce(p_currency, '')));
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three-letter currency code';
  END IF;
  IF code = accounting.base_currency(p_tenant) THEN
    RAISE EXCEPTION 'That is your base currency';
  END IF;
  IF coalesce(p_rate, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter a rate above zero';
  END IF;

  INSERT INTO accounting.exchange_rates (tenant_id, currency, rate_date, rate)
    VALUES (p_tenant, code, p_date, p_rate)
    ON CONFLICT (tenant_id, currency, rate_date) DO UPDATE SET rate = p_rate;
END;
$$;

CREATE FUNCTION accounting.set_base_currency(p_tenant UUID, p_currency TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  code TEXT := upper(trim(coalesce(p_currency, '')));
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three-letter currency code';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting.journal_entries WHERE tenant_id = p_tenant)
     OR EXISTS (SELECT 1 FROM accounting.invoices WHERE tenant_id = p_tenant)
     OR EXISTS (SELECT 1 FROM accounting.bills WHERE tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'The base currency can only be set before anything is recorded';
  END IF;

  INSERT INTO accounting.settings (tenant_id, base_currency) VALUES (p_tenant, code)
    ON CONFLICT (tenant_id) DO UPDATE SET base_currency = code, updated_at = now();
END;
$$;

-- Fills the new columns on existing documents through the triggers above.
UPDATE accounting.invoices SET updated_at = updated_at;
UPDATE accounting.bills SET updated_at = updated_at;

ALTER TABLE accounting.invoices ALTER COLUMN currency SET NOT NULL;
ALTER TABLE accounting.bills ALTER COLUMN currency SET NOT NULL;

GRANT INSERT (currency, exchange_rate) ON accounting.bills TO authenticated;
GRANT UPDATE (currency, exchange_rate) ON accounting.bills TO authenticated;

REVOKE EXECUTE ON FUNCTION
  accounting.base_currency(UUID),
  accounting.settle_amount(NUMERIC, NUMERIC, NUMERIC, NUMERIC),
  accounting.record_payment(UUID, UUID, UUID, UUID, DATE, NUMERIC, TEXT, NUMERIC),
  accounting.currency_overview(UUID),
  accounting.save_exchange_rate(UUID, TEXT, DATE, NUMERIC),
  accounting.set_base_currency(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  accounting.base_currency(UUID),
  accounting.record_payment(UUID, UUID, UUID, UUID, DATE, NUMERIC, TEXT, NUMERIC),
  accounting.currency_overview(UUID),
  accounting.save_exchange_rate(UUID, TEXT, DATE, NUMERIC),
  accounting.set_base_currency(UUID, TEXT)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
