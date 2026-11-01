-- Run after supabase-migration-004.
-- Customers, vendors, bills, partial payments and credit notes.
-- An invoice or bill balance only moves through payments and credit notes, which post to the ledger.
CREATE TABLE accounting.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT,
  phone TEXT,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_customers_tenant ON accounting.customers(tenant_id);

CREATE TABLE accounting.vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT,
  phone TEXT,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_vendors_tenant ON accounting.vendors(tenant_id);

CREATE TABLE accounting.bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES accounting.vendors(id),
  bill_number TEXT NOT NULL,
  vendor_ref TEXT,
  bill_date DATE NOT NULL DEFAULT current_date,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'partial', 'paid', 'void')),
  line_items JSONB NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, bill_number)
);
CREATE INDEX idx_bills_vendor ON accounting.bills(vendor_id);

ALTER TABLE accounting.invoices
  ADD COLUMN customer_id UUID REFERENCES accounting.customers(id),
  ADD COLUMN invoice_date DATE NOT NULL DEFAULT current_date,
  ADD COLUMN amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN amount_credited NUMERIC(14, 2) NOT NULL DEFAULT 0;
CREATE INDEX idx_invoices_customer ON accounting.invoices(customer_id);

ALTER TABLE accounting.invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE accounting.invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'sent', 'partial', 'paid', 'void'));

CREATE TABLE accounting.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES accounting.invoices(id),
  bill_id UUID REFERENCES accounting.bills(id),
  account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  payment_date DATE NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  reference TEXT,
  voided_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  CHECK (num_nonnulls(invoice_id, bill_id) = 1)
);
CREATE INDEX idx_payments_invoice ON accounting.payments(invoice_id);
CREATE INDEX idx_payments_bill ON accounting.payments(bill_id);
CREATE INDEX idx_payments_account ON accounting.payments(account_id);
CREATE INDEX idx_payments_tenant ON accounting.payments(tenant_id);

CREATE TABLE accounting.credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES accounting.invoices(id),
  credit_number TEXT NOT NULL,
  credit_date DATE NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  voided_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, credit_number)
);
CREATE INDEX idx_credit_notes_invoice ON accounting.credit_notes(invoice_id);

ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN ('manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note'));

-- Existing invoices get a customer, a date and, when paid, a payment that takes over their ledger entry.
INSERT INTO accounting.customers (tenant_id, name, email)
  SELECT DISTINCT ON (tenant_id, lower(trim(customer_name))) tenant_id, trim(customer_name), customer_email
  FROM accounting.invoices
  ORDER BY tenant_id, lower(trim(customer_name)), created_at DESC;

UPDATE accounting.invoices i
  SET customer_id = c.id, invoice_date = i.created_at::date,
    amount_paid = CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END
  FROM accounting.customers c
  WHERE c.tenant_id = i.tenant_id AND lower(c.name) = lower(trim(i.customer_name));

ALTER TABLE accounting.invoices ALTER COLUMN customer_id SET NOT NULL;

WITH moved AS (
  INSERT INTO accounting.payments (tenant_id, invoice_id, account_id, payment_date, amount)
    SELECT i.tenant_id, i.id, accounting.account_by_code(i.tenant_id, '1000'), e.entry_date, i.amount
    FROM accounting.invoices i
    JOIN accounting.journal_entries e
      ON e.source_type = 'invoice_payment' AND e.source_id = i.id AND e.reversal_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM accounting.journal_entries r WHERE r.reversal_of = e.id)
    WHERE i.status = 'paid'
    RETURNING id, invoice_id
)
UPDATE accounting.journal_entries e
  SET source_type = 'payment', source_id = moved.id
  FROM moved
  WHERE e.source_type = 'invoice_payment' AND e.source_id = moved.invoice_id AND e.reversal_of IS NULL;

ALTER TABLE accounting.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.credit_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON accounting.customers FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.vendors FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.bills FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.payments FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.credit_notes FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));

-- Customers and vendors keep their history, so they are deactivated rather than deleted.
-- Payments and credit notes can only be written through the functions below.
GRANT SELECT ON accounting.customers, accounting.vendors, accounting.payments, accounting.credit_notes TO authenticated;
GRANT INSERT (tenant_id, name, email, phone, address) ON accounting.customers, accounting.vendors TO authenticated;
GRANT UPDATE (name, email, phone, address, is_active) ON accounting.customers, accounting.vendors TO authenticated;
GRANT SELECT, DELETE ON accounting.bills TO authenticated;
GRANT INSERT (tenant_id, vendor_id, vendor_ref, bill_date, due_date, line_items, notes) ON accounting.bills TO authenticated;
GRANT UPDATE (vendor_id, vendor_ref, bill_date, due_date, line_items, notes, status, updated_at) ON accounting.bills TO authenticated;

CREATE FUNCTION accounting.require_member(p_tenant UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
END;
$$;

-- Same idea as sync_source, for entries with more than one debit.
CREATE FUNCTION accounting.sync_entry(
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
      (SELECT account_id, debit, credit FROM accounting.journal_lines WHERE entry_id = active
       EXCEPT
       SELECT (l->>'account_id')::uuid, coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0)
       FROM jsonb_array_elements(p_lines) l)
      UNION ALL
      (SELECT (l->>'account_id')::uuid, coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0)
       FROM jsonb_array_elements(p_lines) l
       EXCEPT
       SELECT account_id, debit, credit FROM accounting.journal_lines WHERE entry_id = active)
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

-- Status and paid totals are always worked out here, so a direct write cannot set them.
CREATE FUNCTION accounting.prepare_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  paid NUMERIC;
  credited NUMERIC;
BEGIN
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
CREATE TRIGGER prepare_invoice BEFORE INSERT OR UPDATE ON accounting.invoices
  FOR EACH ROW EXECUTE FUNCTION accounting.prepare_invoice();

-- Payments now post themselves, so an invoice only posts the sale.
CREATE OR REPLACE FUNCTION accounting.post_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.sync_source(
    NEW.tenant_id, 'invoice', NEW.id, NEW.invoice_date,
    'Invoice ' || NEW.invoice_number,
    accounting.account_by_code(NEW.tenant_id, '1200'),
    accounting.account_by_code(NEW.tenant_id, '4000'),
    CASE WHEN NEW.status IN ('sent', 'partial', 'paid') THEN NEW.amount ELSE 0 END
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION accounting.prepare_bill()
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
      AND a.type IN ('expense', 'asset') AND a.code <> '1200'
    WHERE a.id IS NULL OR coalesce(round((l->>'amount')::numeric, 2), 0) <= 0
  ) THEN
    RAISE EXCEPTION 'Each line needs an expense or asset account and an amount';
  END IF;
  SELECT sum(round((l->>'amount')::numeric, 2)) INTO NEW.amount
    FROM jsonb_array_elements(NEW.line_items) l;

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
CREATE TRIGGER prepare_bill BEFORE INSERT OR UPDATE ON accounting.bills
  FOR EACH ROW EXECUTE FUNCTION accounting.prepare_bill();

CREATE FUNCTION accounting.post_bill()
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
  END IF;

  PERFORM accounting.sync_entry(
    NEW.tenant_id, 'bill', NEW.id, NEW.bill_date, 'Bill ' || NEW.bill_number, entry_lines
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER post_bill AFTER INSERT OR UPDATE ON accounting.bills
  FOR EACH ROW EXECUTE FUNCTION accounting.post_bill();

CREATE FUNCTION accounting.protect_posted_bill()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF OLD.status <> 'draft' AND EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Only draft bills can be deleted. Void this bill instead.';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER protect_posted_bill BEFORE DELETE ON accounting.bills
  FOR EACH ROW EXECUTE FUNCTION accounting.protect_posted_bill();

-- Locking the document stops two payments from overpaying it.
CREATE FUNCTION accounting.record_payment(
  p_tenant UUID, p_invoice UUID, p_bill UUID, p_account UUID, p_date DATE, p_amount NUMERIC, p_reference TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc_label TEXT;
  doc_status TEXT;
  balance NUMERIC;
  amount NUMERIC := round(p_amount, 2);
  new_id UUID;
  control UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF num_nonnulls(p_invoice, p_bill) <> 1 THEN
    RAISE EXCEPTION 'Choose an invoice or a bill';
  END IF;

  IF p_invoice IS NOT NULL THEN
    SELECT invoice_number, status, i.amount - amount_paid - amount_credited
      INTO doc_label, doc_status, balance
      FROM accounting.invoices i WHERE id = p_invoice AND tenant_id = p_tenant FOR UPDATE;
    control := accounting.account_by_code(p_tenant, '1200');
  ELSE
    SELECT bill_number, status, b.amount - amount_paid
      INTO doc_label, doc_status, balance
      FROM accounting.bills b WHERE id = p_bill AND tenant_id = p_tenant FOR UPDATE;
    control := accounting.account_by_code(p_tenant, '2000');
  END IF;

  IF doc_label IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF doc_status NOT IN ('sent', 'open', 'partial') THEN
    RAISE EXCEPTION 'Only sent or approved documents with a balance can be paid';
  END IF;
  IF coalesce(amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an amount';
  END IF;
  IF amount > balance THEN
    RAISE EXCEPTION 'That is more than the % still owed', balance;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts
    WHERE id = p_account AND tenant_id = p_tenant AND type = 'asset' AND is_active AND code <> '1200'
  ) THEN
    RAISE EXCEPTION 'Choose a cash or bank account';
  END IF;

  INSERT INTO accounting.payments (tenant_id, invoice_id, bill_id, account_id, payment_date, amount, reference)
    VALUES (p_tenant, p_invoice, p_bill, p_account, p_date, amount, nullif(trim(p_reference), ''))
    RETURNING id INTO new_id;

  PERFORM accounting.insert_entry(
    p_tenant, p_date, 'Payment for ' || doc_label, 'payment', new_id, NULL,
    CASE WHEN p_invoice IS NOT NULL THEN jsonb_build_array(
      jsonb_build_object('account_id', p_account, 'debit', amount),
      jsonb_build_object('account_id', control, 'credit', amount)
    ) ELSE jsonb_build_array(
      jsonb_build_object('account_id', control, 'debit', amount),
      jsonb_build_object('account_id', p_account, 'credit', amount)
    ) END
  );

  UPDATE accounting.invoices SET updated_at = now() WHERE id = p_invoice;
  UPDATE accounting.bills SET updated_at = now() WHERE id = p_bill;
  RETURN new_id;
END;
$$;

CREATE FUNCTION accounting.void_payment(p_tenant UUID, p_payment UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  payment accounting.payments;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO payment FROM accounting.payments WHERE id = p_payment AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF payment.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'This payment has already been voided';
  END IF;

  UPDATE accounting.payments SET voided_at = now() WHERE id = p_payment;
  PERFORM accounting.reverse_entry(id) FROM accounting.journal_entries
    WHERE source_type = 'payment' AND source_id = p_payment AND reversal_of IS NULL;

  UPDATE accounting.invoices SET updated_at = now() WHERE id = payment.invoice_id;
  UPDATE accounting.bills SET updated_at = now() WHERE id = payment.bill_id;
END;
$$;

-- A credit note reduces what a customer owes on one invoice. Refunds of paid money are not handled yet.
CREATE FUNCTION accounting.create_credit_note(
  p_tenant UUID, p_invoice UUID, p_date DATE, p_amount NUMERIC, p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  amount NUMERIC := round(p_amount, 2);
  next_number BIGINT;
  number_text TEXT;
  new_id UUID;
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

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 2));
  SELECT coalesce(max(substring(credit_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
    FROM accounting.credit_notes WHERE tenant_id = p_tenant;
  number_text := 'CN-' || lpad(next_number::text, 4, '0');

  INSERT INTO accounting.credit_notes (tenant_id, invoice_id, credit_number, credit_date, amount, reason)
    VALUES (p_tenant, p_invoice, number_text, p_date, amount, trim(p_reason))
    RETURNING id INTO new_id;

  PERFORM accounting.insert_entry(
    p_tenant, p_date, 'Credit note ' || number_text || ' for ' || invoice.invoice_number, 'credit_note', new_id, NULL,
    jsonb_build_array(
      jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '4000'), 'debit', amount),
      jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '1200'), 'credit', amount)
    )
  );

  UPDATE accounting.invoices SET updated_at = now() WHERE id = p_invoice;
  RETURN new_id;
END;
$$;

CREATE FUNCTION accounting.void_credit_note(p_tenant UUID, p_credit UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  credit accounting.credit_notes;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO credit FROM accounting.credit_notes WHERE id = p_credit AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF credit.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'This credit note has already been voided';
  END IF;

  UPDATE accounting.credit_notes SET voided_at = now() WHERE id = p_credit;
  PERFORM accounting.reverse_entry(id) FROM accounting.journal_entries
    WHERE source_type = 'credit_note' AND source_id = p_credit AND reversal_of IS NULL;

  UPDATE accounting.invoices SET updated_at = now() WHERE id = credit.invoice_id;
END;
$$;

CREATE FUNCTION accounting.customer_list(p_tenant UUID)
RETURNS TABLE (
  id UUID, name TEXT, email TEXT, phone TEXT, address TEXT, is_active BOOLEAN, balance NUMERIC
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT c.id, c.name, c.email, c.phone, c.address, c.is_active,
    coalesce(sum(i.amount - i.amount_paid - i.amount_credited), 0)
  FROM accounting.customers c
  LEFT JOIN accounting.invoices i ON i.customer_id = c.id AND i.status IN ('sent', 'partial')
  WHERE c.tenant_id = p_tenant
  GROUP BY c.id
  ORDER BY c.name;
$$;

CREATE FUNCTION accounting.vendor_list(p_tenant UUID)
RETURNS TABLE (
  id UUID, name TEXT, email TEXT, phone TEXT, address TEXT, is_active BOOLEAN, balance NUMERIC
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT v.id, v.name, v.email, v.phone, v.address, v.is_active,
    coalesce(sum(b.amount - b.amount_paid), 0)
  FROM accounting.vendors v
  LEFT JOIN accounting.bills b ON b.vendor_id = v.id AND b.status IN ('open', 'partial')
  WHERE v.tenant_id = p_tenant
  GROUP BY v.id
  ORDER BY v.name;
$$;

-- Income figures now come from the ledger, so bills, credit notes and manual entries all count.
CREATE OR REPLACE FUNCTION accounting.summary(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH books AS (
    SELECT
      coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type = 'revenue'), 0) AS revenue,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0) AS expenses
    FROM accounting.journal_lines l
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant
  ), inv AS (
    SELECT
      coalesce(sum(amount - amount_paid - amount_credited) FILTER (WHERE status IN ('sent', 'partial')), 0) AS outstanding,
      coalesce(sum(amount - amount_paid - amount_credited)
        FILTER (WHERE status IN ('sent', 'partial') AND due_date < current_date), 0) AS overdue,
      count(*) AS invoice_count
    FROM accounting.invoices WHERE tenant_id = p_tenant
  ), bil AS (
    SELECT coalesce(sum(amount - amount_paid) FILTER (WHERE status IN ('open', 'partial')), 0) AS payables
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

NOTIFY pgrst, 'reload schema';
