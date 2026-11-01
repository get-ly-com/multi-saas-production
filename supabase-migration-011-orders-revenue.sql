-- Run after supabase-migration-010.
-- Purchase orders with approvals, a bill approval limit, recurring invoices and revenue recognition.
ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note', 'bank', 'closing',
    'asset', 'depreciation', 'vendor_credit', 'revenue'
  ));

ALTER TABLE accounting.settings ADD COLUMN bill_approval_limit NUMERIC(14, 2) CHECK (bill_approval_limit >= 0);

CREATE TABLE accounting.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  po_number TEXT NOT NULL,
  vendor_id UUID NOT NULL REFERENCES accounting.vendors(id),
  order_date DATE NOT NULL,
  expected_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'billed')),
  currency TEXT NOT NULL,
  exchange_rate NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  line_items JSONB NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  notes TEXT,
  requested_by UUID,
  decided_by UUID,
  decided_at TIMESTAMP,
  decision_note TEXT,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, po_number)
);
CREATE INDEX idx_purchase_orders_vendor ON accounting.purchase_orders(vendor_id);

ALTER TABLE accounting.bills
  ADD COLUMN po_id UUID REFERENCES accounting.purchase_orders(id),
  ADD COLUMN approved_by UUID,
  ADD COLUMN approved_at TIMESTAMP;
CREATE INDEX idx_bills_po ON accounting.bills(po_id);

CREATE TABLE accounting.recurring_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  customer_id UUID NOT NULL REFERENCES accounting.customers(id),
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  start_date DATE NOT NULL,
  end_date DATE,
  due_days INT NOT NULL DEFAULT 30 CHECK (due_days >= 0),
  currency TEXT NOT NULL,
  exchange_rate NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  cost_center_id UUID REFERENCES accounting.cost_centers(id),
  line_items JSONB NOT NULL,
  auto_send BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  runs_done INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_recurring_tenant ON accounting.recurring_invoices(tenant_id);
CREATE INDEX idx_recurring_customer ON accounting.recurring_invoices(customer_id);
CREATE INDEX idx_recurring_cost_center ON accounting.recurring_invoices(cost_center_id);

CREATE TABLE accounting.revenue_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES accounting.invoices(id),
  start_date DATE NOT NULL,
  months INT NOT NULL CHECK (months > 0),
  total NUMERIC(14, 2) NOT NULL CHECK (total > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled')),
  created_at TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX idx_revenue_one_per_invoice ON accounting.revenue_schedules(invoice_id) WHERE status <> 'cancelled';
CREATE INDEX idx_revenue_tenant ON accounting.revenue_schedules(tenant_id);

CREATE TABLE accounting.revenue_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES accounting.revenue_schedules(id) ON DELETE CASCADE,
  period DATE NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  entry_id UUID NOT NULL REFERENCES accounting.journal_entries(id),
  UNIQUE (schedule_id, period)
);
CREATE INDEX idx_revenue_lines_entry ON accounting.revenue_lines(entry_id);
CREATE INDEX idx_revenue_lines_tenant ON accounting.revenue_lines(tenant_id);

ALTER TABLE accounting.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.recurring_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.revenue_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.revenue_lines ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'accounting.purchase_orders', 'accounting.recurring_invoices',
    'accounting.revenue_schedules', 'accounting.revenue_lines'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_rows ON %s FOR SELECT TO authenticated
         USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))',
      target
    );
    EXECUTE format('GRANT SELECT ON %s TO authenticated', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    'accounting.purchase_orders', 'accounting.recurring_invoices', 'accounting.revenue_schedules'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION accounting.audit_row()',
      target
    );
  END LOOP;
END;
$$;

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
    (p_tenant, '2200', 'Deferred Revenue', 'liability', true, false),
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

-- Named to run after prepare_bill, so the amount and status are final.
CREATE FUNCTION accounting.check_bill_approval()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  approval_limit NUMERIC;
  po_amount NUMERIC;
  member_role TEXT;
BEGIN
  IF OLD.status <> 'draft' OR NEW.status IN ('draft', 'void') THEN
    RETURN NEW;
  END IF;

  SELECT bill_approval_limit INTO approval_limit FROM accounting.settings WHERE tenant_id = NEW.tenant_id;
  SELECT amount INTO po_amount FROM accounting.purchase_orders WHERE id = NEW.po_id;

  IF NEW.base_amount > approval_limit AND (po_amount IS NULL OR NEW.amount > po_amount) THEN
    SELECT role INTO member_role FROM public.tenant_members
      WHERE tenant_id = NEW.tenant_id AND user_id = auth.uid();
    IF member_role IS NULL OR member_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Bills over % need an owner or admin to approve them', approval_limit;
    END IF;
  END IF;

  NEW.approved_by := auth.uid();
  NEW.approved_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_check_bill_approval BEFORE UPDATE ON accounting.bills
  FOR EACH ROW EXECUTE FUNCTION accounting.check_bill_approval();

CREATE FUNCTION accounting.set_approval_limit(p_tenant UUID, p_limit NUMERIC)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  INSERT INTO accounting.settings (tenant_id, bill_approval_limit) VALUES (p_tenant, p_limit)
    ON CONFLICT (tenant_id) DO UPDATE SET bill_approval_limit = p_limit, updated_at = now();
END;
$$;

-- Purchase orders are commitments, so they post nothing until they become a bill.
CREATE FUNCTION accounting.save_purchase_order(
  p_tenant UUID, p_order UUID, p_vendor UUID, p_date DATE, p_expected DATE,
  p_currency TEXT, p_rate NUMERIC, p_lines JSONB, p_notes TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  home TEXT := accounting.base_currency(p_tenant);
  code TEXT := upper(coalesce(nullif(trim(p_currency), ''), home));
  total NUMERIC;
  next_number BIGINT;
  saved UUID := p_order;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  IF code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three-letter currency code';
  END IF;
  IF code <> home AND coalesce(p_rate, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an exchange rate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounting.vendors WHERE id = p_vendor AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Vendor not found';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one line';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.accounts a
      ON a.id::text = l->>'account_id' AND a.tenant_id = p_tenant
      AND a.type IN ('expense', 'asset') AND a.code NOT IN ('1200', '1590') AND NOT a.is_cash
    WHERE a.id IS NULL OR coalesce((l->>'quantity')::numeric, 0) <= 0 OR coalesce((l->>'unit_price')::numeric, -1) < 0
  ) THEN
    RAISE EXCEPTION 'Each line needs an expense or asset account, a quantity and a price';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id' AND t.tenant_id = p_tenant
    WHERE coalesce(l->>'tax_rate_id', '') <> '' AND t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Tax rate not found';
  END IF;

  SELECT sum(base + round(base * coalesce(rate, 0) / 100, 2)) INTO total
    FROM (
      SELECT round((l->>'quantity')::numeric * (l->>'unit_price')::numeric, 2) AS base, t.rate
      FROM jsonb_array_elements(p_lines) l
      LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id'
    ) lines;

  IF saved IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 6));
    SELECT coalesce(max(substring(po_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
      FROM accounting.purchase_orders WHERE tenant_id = p_tenant;

    INSERT INTO accounting.purchase_orders
        (tenant_id, po_number, vendor_id, order_date, expected_date, currency, exchange_rate,
         line_items, amount, notes, requested_by)
      VALUES (
        p_tenant, 'PO-' || lpad(next_number::text, 4, '0'), p_vendor, p_date, p_expected, code,
        CASE WHEN code = home THEN 1 ELSE p_rate END, p_lines, total, nullif(trim(p_notes), ''), auth.uid()
      )
      RETURNING id INTO saved;
  ELSE
    UPDATE accounting.purchase_orders
      SET vendor_id = p_vendor, order_date = p_date, expected_date = p_expected, currency = code,
        exchange_rate = CASE WHEN code = home THEN 1 ELSE p_rate END,
        line_items = p_lines, amount = total, notes = nullif(trim(p_notes), ''),
        status = 'draft', requested_by = auth.uid(), decided_by = NULL, decided_at = NULL, decision_note = NULL
      WHERE id = saved AND tenant_id = p_tenant AND status IN ('draft', 'rejected');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only draft or rejected orders can be changed';
    END IF;
  END IF;

  RETURN saved;
END;
$$;

CREATE FUNCTION accounting.submit_purchase_order(p_tenant UUID, p_order UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE accounting.purchase_orders SET status = 'pending', requested_by = auth.uid()
    WHERE id = p_order AND tenant_id = p_tenant AND status = 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only draft orders can be submitted';
  END IF;
END;
$$;

-- People cannot approve their own orders, unless nobody else in the company can.
CREATE FUNCTION accounting.decide_purchase_order(p_tenant UUID, p_order UUID, p_approve BOOLEAN, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  purchase accounting.purchase_orders;
BEGIN
  PERFORM accounting.require_manager(p_tenant);

  SELECT * INTO purchase FROM accounting.purchase_orders WHERE id = p_order AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR purchase.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending orders can be decided';
  END IF;

  IF p_approve AND purchase.requested_by = auth.uid() AND EXISTS (
    SELECT 1 FROM public.tenant_members
    WHERE tenant_id = p_tenant AND role IN ('owner', 'admin') AND user_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'Someone else must approve your own order';
  END IF;

  UPDATE accounting.purchase_orders
    SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
    WHERE id = p_order;
END;
$$;

CREATE FUNCTION accounting.bill_purchase_order(p_tenant UUID, p_order UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  purchase accounting.purchase_orders;
  new_bill UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO purchase FROM accounting.purchase_orders WHERE id = p_order AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR purchase.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved orders can become bills';
  END IF;

  INSERT INTO accounting.bills
      (tenant_id, vendor_id, vendor_ref, bill_date, currency, exchange_rate, line_items, amount, notes, po_id)
    SELECT p_tenant, purchase.vendor_id, purchase.po_number, current_date, purchase.currency, purchase.exchange_rate,
      jsonb_agg(jsonb_build_object(
        'description', l->>'description',
        'account_id', l->>'account_id',
        'amount', round((l->>'quantity')::numeric * (l->>'unit_price')::numeric, 2),
        'tax_rate_id', nullif(l->>'tax_rate_id', ''),
        'cost_center_id', nullif(l->>'cost_center_id', '')
      )), purchase.amount, 'From ' || purchase.po_number, p_order
    FROM jsonb_array_elements(purchase.line_items) l
    RETURNING id INTO new_bill;

  UPDATE accounting.purchase_orders SET status = 'billed' WHERE id = p_order;
  RETURN new_bill;
END;
$$;

CREATE FUNCTION accounting.delete_purchase_order(p_tenant UUID, p_order UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  DELETE FROM accounting.purchase_orders
    WHERE id = p_order AND tenant_id = p_tenant AND status IN ('draft', 'rejected');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only draft or rejected orders can be deleted';
  END IF;
END;
$$;

-- Recurring invoices
CREATE FUNCTION accounting.save_recurring_invoice(
  p_tenant UUID, p_id UUID, p_name TEXT, p_customer UUID, p_frequency TEXT, p_start DATE, p_end DATE,
  p_due_days INT, p_currency TEXT, p_rate NUMERIC, p_cost_center UUID, p_lines JSONB, p_auto_send BOOLEAN
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  home TEXT := accounting.base_currency(p_tenant);
  code TEXT := upper(coalesce(nullif(trim(p_currency), ''), home));
  saved UUID := p_id;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  IF code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three-letter currency code';
  END IF;
  IF code <> home AND coalesce(p_rate, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an exchange rate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounting.customers WHERE id = p_customer AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  IF p_cost_center IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM accounting.cost_centers WHERE id = p_cost_center AND tenant_id = p_tenant
  ) THEN
    RAISE EXCEPTION 'Cost center not found';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one line';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id' AND t.tenant_id = p_tenant
    WHERE coalesce(l->>'tax_rate_id', '') <> '' AND t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Tax rate not found';
  END IF;

  IF saved IS NULL THEN
    INSERT INTO accounting.recurring_invoices
        (tenant_id, name, customer_id, frequency, start_date, end_date, due_days, currency, exchange_rate,
         cost_center_id, line_items, auto_send)
      VALUES (
        p_tenant, trim(p_name), p_customer, p_frequency, p_start, p_end, coalesce(p_due_days, 30), code,
        CASE WHEN code = home THEN 1 ELSE p_rate END, p_cost_center, p_lines, coalesce(p_auto_send, false)
      )
      RETURNING id INTO saved;
  ELSE
    UPDATE accounting.recurring_invoices
      SET name = trim(p_name), customer_id = p_customer, frequency = p_frequency,
        start_date = CASE WHEN runs_done = 0 THEN p_start ELSE start_date END,
        end_date = p_end, due_days = coalesce(p_due_days, 30), currency = code,
        exchange_rate = CASE WHEN code = home THEN 1 ELSE p_rate END,
        cost_center_id = p_cost_center, line_items = p_lines, auto_send = coalesce(p_auto_send, false)
      WHERE id = saved AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not found';
    END IF;
  END IF;

  RETURN saved;
END;
$$;

CREATE FUNCTION accounting.set_recurring_active(p_tenant UUID, p_id UUID, p_active BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE accounting.recurring_invoices SET is_active = p_active WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
END;
$$;

-- Every date comes from the start date, so a month-end schedule keeps its day.
CREATE FUNCTION accounting.run_recurring_invoices(p_tenant UUID, p_through DATE)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  home TEXT := accounting.base_currency(p_tenant);
  plan accounting.recurring_invoices;
  step_months INT;
  run_date DATE;
  use_rate NUMERIC;
  next_number BIGINT;
  new_id UUID;
  created INT := 0;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_through IS NULL THEN
    RAISE EXCEPTION 'Choose a date';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 7));

  FOR plan IN
    SELECT * FROM accounting.recurring_invoices WHERE tenant_id = p_tenant AND is_active FOR UPDATE
  LOOP
    step_months := CASE plan.frequency WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 ELSE 12 END;

    LOOP
      run_date := (plan.start_date + make_interval(months => plan.runs_done * step_months))::date;
      EXIT WHEN run_date > p_through OR run_date > plan.end_date;

      SELECT coalesce((
        SELECT rate FROM accounting.exchange_rates
        WHERE tenant_id = p_tenant AND currency = plan.currency AND rate_date <= run_date
        ORDER BY rate_date DESC LIMIT 1
      ), plan.exchange_rate) INTO use_rate;

      SELECT coalesce(max(substring(invoice_number FROM '^INV-(\d+)$')::bigint), 0) + 1 INTO next_number
        FROM accounting.invoices WHERE tenant_id = p_tenant;

      INSERT INTO accounting.invoices
          (tenant_id, invoice_number, customer_id, invoice_date, due_date, amount, currency, exchange_rate,
           cost_center_id, line_items, description)
        VALUES (
          p_tenant, 'INV-' || lpad(next_number::text, 4, '0'), plan.customer_id, run_date,
          run_date + plan.due_days, 0, plan.currency, CASE WHEN plan.currency = home THEN 1 ELSE use_rate END,
          plan.cost_center_id, plan.line_items, plan.name
        )
        RETURNING id INTO new_id;

      IF plan.auto_send THEN
        UPDATE accounting.invoices SET status = 'sent' WHERE id = new_id;
      END IF;

      plan.runs_done := plan.runs_done + 1;
      created := created + 1;
    END LOOP;

    UPDATE accounting.recurring_invoices SET runs_done = plan.runs_done WHERE id = plan.id;
  END LOOP;

  RETURN created;
END;
$$;

-- Revenue recognition: an invoice's sale moves to Deferred Revenue, then is earned month by month.
CREATE FUNCTION accounting.create_revenue_schedule(p_tenant UUID, p_invoice UUID, p_start DATE, p_months INT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  total NUMERIC;
  new_id UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO invoice FROM accounting.invoices WHERE id = p_invoice AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF invoice.status NOT IN ('sent', 'partial', 'paid') THEN
    RAISE EXCEPTION 'Only posted invoices can be scheduled';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting.revenue_schedules WHERE invoice_id = p_invoice AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'This invoice already has a revenue schedule';
  END IF;
  IF coalesce(p_months, 0) < 1 THEN
    RAISE EXCEPTION 'Enter the number of months';
  END IF;
  IF p_start IS NULL THEN
    RAISE EXCEPTION 'Choose a start date';
  END IF;

  total := invoice.base_amount - round(invoice.tax_amount * invoice.exchange_rate, 2);

  INSERT INTO accounting.revenue_schedules (tenant_id, invoice_id, start_date, months, total)
    VALUES (p_tenant, p_invoice, date_trunc('month', p_start)::date, p_months, total)
    RETURNING id INTO new_id;

  PERFORM accounting.insert_entry(
    p_tenant, invoice.invoice_date, 'Deferred revenue for ' || invoice.invoice_number, 'revenue', new_id, NULL,
    jsonb_build_array(
      jsonb_build_object(
        'account_id', accounting.account_by_code(p_tenant, '4000'), 'debit', total,
        'cost_center_id', invoice.cost_center_id
      ),
      jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '2200'), 'credit', total)
    )
  );
  RETURN new_id;
END;
$$;

-- Named to run after prepare_invoice, so the amounts are final.
CREATE FUNCTION accounting.check_revenue_schedule()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (NEW.status = 'void' OR NEW.base_amount <> OLD.base_amount) AND EXISTS (
    SELECT 1 FROM accounting.revenue_schedules WHERE invoice_id = NEW.id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Cancel this invoice''s revenue schedule first';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_check_revenue_schedule BEFORE UPDATE ON accounting.invoices
  FOR EACH ROW EXECUTE FUNCTION accounting.check_revenue_schedule();

CREATE FUNCTION accounting.recognize_amount(p_schedule accounting.revenue_schedules, p_period DATE, p_amount NUMERIC, p_date DATE, p_memo TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  center UUID;
  new_entry UUID;
BEGIN
  SELECT cost_center_id INTO center FROM accounting.invoices WHERE id = p_schedule.invoice_id;

  new_entry := accounting.insert_entry(
    p_schedule.tenant_id, p_date, p_memo, 'revenue', p_schedule.id, NULL,
    jsonb_build_array(
      jsonb_build_object('account_id', accounting.account_by_code(p_schedule.tenant_id, '2200'), 'debit', p_amount),
      jsonb_build_object(
        'account_id', accounting.account_by_code(p_schedule.tenant_id, '4000'), 'credit', p_amount,
        'cost_center_id', center
      )
    )
  );

  INSERT INTO accounting.revenue_lines (tenant_id, schedule_id, period, amount, entry_id)
    VALUES (p_schedule.tenant_id, p_schedule.id, p_period, p_amount, new_entry);
END;
$$;

-- Running it twice adds nothing, and the last month takes any rounding.
CREATE FUNCTION accounting.run_revenue_recognition(p_tenant UUID, p_through DATE)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  schedule accounting.revenue_schedules;
  this_month DATE;
  month_end DATE;
  booked NUMERIC;
  months_done INT;
  charge NUMERIC;
  label TEXT;
  posted INT := 0;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_through IS NULL THEN
    RAISE EXCEPTION 'Choose a date';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 8));

  FOR schedule IN
    SELECT * FROM accounting.revenue_schedules WHERE tenant_id = p_tenant AND status = 'active' ORDER BY start_date FOR UPDATE
  LOOP
    SELECT invoice_number INTO label FROM accounting.invoices WHERE id = schedule.invoice_id;
    this_month := schedule.start_date;

    LOOP
      month_end := (this_month + interval '1 month' - interval '1 day')::date;
      EXIT WHEN month_end > p_through;

      SELECT coalesce(sum(amount), 0), count(*) INTO booked, months_done
        FROM accounting.revenue_lines WHERE schedule_id = schedule.id;
      EXIT WHEN months_done >= schedule.months;

      IF NOT EXISTS (SELECT 1 FROM accounting.revenue_lines WHERE schedule_id = schedule.id AND period = this_month) THEN
        charge := CASE WHEN months_done + 1 >= schedule.months
          THEN schedule.total - booked
          ELSE round(schedule.total / schedule.months, 2)
        END;
        PERFORM accounting.recognize_amount(
          schedule, this_month, charge, month_end,
          'Revenue earned for ' || label || ', ' || to_char(this_month, 'Mon YYYY')
        );
        posted := posted + 1;
        IF months_done + 1 >= schedule.months THEN
          UPDATE accounting.revenue_schedules SET status = 'done' WHERE id = schedule.id;
        END IF;
      END IF;

      this_month := (this_month + interval '1 month')::date;
    END LOOP;
  END LOOP;

  RETURN posted;
END;
$$;

-- Cancelling earns whatever is left today, so no revenue stays stranded in Deferred Revenue.
CREATE FUNCTION accounting.cancel_revenue_schedule(p_tenant UUID, p_schedule UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  schedule accounting.revenue_schedules;
  booked NUMERIC;
  label TEXT;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO schedule FROM accounting.revenue_schedules WHERE id = p_schedule AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR schedule.status <> 'active' THEN
    RAISE EXCEPTION 'Only active schedules can be cancelled';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO booked FROM accounting.revenue_lines WHERE schedule_id = p_schedule;
  SELECT invoice_number INTO label FROM accounting.invoices WHERE id = schedule.invoice_id;

  IF schedule.total - booked > 0 THEN
    PERFORM accounting.recognize_amount(
      schedule, '9999-01-01'::date, schedule.total - booked, current_date,
      'Remaining revenue earned for ' || label
    );
  END IF;

  UPDATE accounting.revenue_schedules SET status = 'cancelled' WHERE id = p_schedule;
END;
$$;

CREATE FUNCTION accounting.revenue_overview(p_tenant UUID)
RETURNS TABLE (
  id UUID, invoice_id UUID, invoice_number TEXT, customer_name TEXT, start_date DATE, months INT,
  total NUMERIC, earned NUMERIC, deferred NUMERIC, status TEXT
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT s.id, s.invoice_id, i.invoice_number, i.customer_name, s.start_date, s.months, s.total,
    coalesce(sum(l.amount), 0), s.total - coalesce(sum(l.amount), 0), s.status
  FROM accounting.revenue_schedules s
  JOIN accounting.invoices i ON i.id = s.invoice_id
  LEFT JOIN accounting.revenue_lines l ON l.schedule_id = s.id
  WHERE s.tenant_id = p_tenant
  GROUP BY s.id, i.invoice_number, i.customer_name
  ORDER BY s.status, s.start_date DESC;
$$;

REVOKE EXECUTE ON FUNCTION
  accounting.check_bill_approval(),
  accounting.check_revenue_schedule(),
  accounting.recognize_amount(accounting.revenue_schedules, DATE, NUMERIC, DATE, TEXT),
  accounting.set_approval_limit(UUID, NUMERIC),
  accounting.save_purchase_order(UUID, UUID, UUID, DATE, DATE, TEXT, NUMERIC, JSONB, TEXT),
  accounting.submit_purchase_order(UUID, UUID),
  accounting.decide_purchase_order(UUID, UUID, BOOLEAN, TEXT),
  accounting.bill_purchase_order(UUID, UUID),
  accounting.delete_purchase_order(UUID, UUID),
  accounting.save_recurring_invoice(UUID, UUID, TEXT, UUID, TEXT, DATE, DATE, INT, TEXT, NUMERIC, UUID, JSONB, BOOLEAN),
  accounting.set_recurring_active(UUID, UUID, BOOLEAN),
  accounting.run_recurring_invoices(UUID, DATE),
  accounting.create_revenue_schedule(UUID, UUID, DATE, INT),
  accounting.run_revenue_recognition(UUID, DATE),
  accounting.cancel_revenue_schedule(UUID, UUID),
  accounting.revenue_overview(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  accounting.set_approval_limit(UUID, NUMERIC),
  accounting.save_purchase_order(UUID, UUID, UUID, DATE, DATE, TEXT, NUMERIC, JSONB, TEXT),
  accounting.submit_purchase_order(UUID, UUID),
  accounting.decide_purchase_order(UUID, UUID, BOOLEAN, TEXT),
  accounting.bill_purchase_order(UUID, UUID),
  accounting.delete_purchase_order(UUID, UUID),
  accounting.save_recurring_invoice(UUID, UUID, TEXT, UUID, TEXT, DATE, DATE, INT, TEXT, NUMERIC, UUID, JSONB, BOOLEAN),
  accounting.set_recurring_active(UUID, UUID, BOOLEAN),
  accounting.run_recurring_invoices(UUID, DATE),
  accounting.create_revenue_schedule(UUID, UUID, DATE, INT),
  accounting.run_revenue_recognition(UUID, DATE),
  accounting.cancel_revenue_schedule(UUID, UUID),
  accounting.revenue_overview(UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
