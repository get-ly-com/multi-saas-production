-- Run after supabase-migration-005.
-- Profit and loss, balance sheet, cash flow and aged balances, all worked out from the ledger.
-- Cash and bank accounts are now marked, because other asset accounts are not cash.
ALTER TABLE accounting.accounts
  ADD COLUMN is_cash BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT accounts_cash_is_asset CHECK (NOT is_cash OR type = 'asset');
UPDATE accounting.accounts SET is_cash = true WHERE code = '1000' AND is_system;
GRANT INSERT (is_cash) ON accounting.accounts TO authenticated;

CREATE OR REPLACE FUNCTION accounting.seed_chart(p_tenant UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
  VALUES
    (p_tenant, '1000', 'Cash', 'asset', true, true),
    (p_tenant, '1200', 'Accounts Receivable', 'asset', true, false),
    (p_tenant, '2000', 'Accounts Payable', 'liability', true, false),
    (p_tenant, '3000', 'Owner''s Equity', 'equity', true, false),
    (p_tenant, '3100', 'Retained Earnings', 'equity', true, false),
    (p_tenant, '4000', 'Sales Revenue', 'revenue', true, false),
    (p_tenant, '5000', 'Cost of Goods Sold', 'expense', true, false),
    (p_tenant, '6000', 'General Expenses', 'expense', true, false)
  ON CONFLICT (tenant_id, code) DO NOTHING;
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

CREATE OR REPLACE FUNCTION accounting.record_payment(
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
    WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active
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

CREATE FUNCTION accounting.profit_and_loss(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH rows AS (
    SELECT a.id AS account_id, a.code, a.name, a.type,
      sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE l.debit - l.credit END) AS amount
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND a.type IN ('revenue', 'expense')
      AND e.entry_date BETWEEN p_from AND p_to
    GROUP BY a.id
    HAVING sum(l.debit - l.credit) <> 0
  ), totals AS (
    SELECT
      coalesce(sum(amount) FILTER (WHERE type = 'revenue'), 0) AS revenue,
      coalesce(sum(amount) FILTER (WHERE type = 'expense'), 0) AS expenses
    FROM rows
  )
  SELECT json_build_object(
    'revenue', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'revenue'), '[]'::json),
    'expenses', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'expense'), '[]'::json),
    'total_revenue', totals.revenue,
    'total_expenses', totals.expenses,
    'net_income', totals.revenue - totals.expenses
  ) FROM totals;
$$;

-- There is no year-end close yet, so all earnings to date show as one equity line.
CREATE FUNCTION accounting.balance_sheet(p_tenant UUID, p_as_of DATE)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH rows AS (
    SELECT a.id AS account_id, a.code, a.name, a.type,
      sum(CASE WHEN a.type IN ('asset', 'expense') THEN l.debit - l.credit ELSE l.credit - l.debit END) AS amount
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND e.entry_date <= p_as_of
    GROUP BY a.id
    HAVING sum(l.debit - l.credit) <> 0
  ), totals AS (
    SELECT
      coalesce(sum(amount) FILTER (WHERE type = 'asset'), 0) AS assets,
      coalesce(sum(amount) FILTER (WHERE type = 'liability'), 0) AS liabilities,
      coalesce(sum(amount) FILTER (WHERE type = 'equity'), 0) AS equity,
      coalesce(sum(amount) FILTER (WHERE type = 'revenue'), 0)
        - coalesce(sum(amount) FILTER (WHERE type = 'expense'), 0) AS earnings
    FROM rows
  )
  SELECT json_build_object(
    'assets', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'asset'), '[]'::json),
    'liabilities', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'liability'), '[]'::json),
    'equity', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'equity'), '[]'::json),
    'earnings', totals.earnings,
    'total_assets', totals.assets,
    'total_liabilities', totals.liabilities,
    'total_equity', totals.equity + totals.earnings,
    'balanced', totals.assets = totals.liabilities + totals.equity + totals.earnings
  ) FROM totals;
$$;

-- Each entry balances, so the other side of every cash movement says where the money came from.
CREATE FUNCTION accounting.cash_flow(p_tenant UUID, p_from DATE, p_to DATE)
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
        WHEN a.type IN ('revenue', 'expense') OR a.code IN ('1200', '2000') THEN 'operating'
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

-- A document with no due date is treated as due on its own date.
CREATE FUNCTION accounting.aged_balances(p_tenant UUID, p_kind TEXT)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH docs AS (
    SELECT c.id AS party_id, c.name,
      i.amount - i.amount_paid - i.amount_credited AS balance,
      current_date - coalesce(i.due_date, i.invoice_date) AS days
    FROM accounting.invoices i
    JOIN accounting.customers c ON c.id = i.customer_id
    WHERE p_kind = 'receivable' AND i.tenant_id = p_tenant AND i.status IN ('sent', 'partial')
    UNION ALL
    SELECT v.id, v.name,
      b.amount - b.amount_paid,
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

NOTIFY pgrst, 'reload schema';
