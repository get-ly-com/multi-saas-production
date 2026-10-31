-- Run after supabase-migration-003. Already applied to the production project.
-- Double-entry ledger. Entries are never edited: corrections are posted as reversals.
CREATE TABLE accounting.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE accounting.journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  entry_number BIGINT NOT NULL,
  entry_date DATE NOT NULL,
  memo TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'invoice', 'invoice_payment', 'expense')),
  source_id UUID,
  reversal_of UUID REFERENCES accounting.journal_entries(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (tenant_id, entry_number)
);
CREATE UNIQUE INDEX idx_entries_one_reversal ON accounting.journal_entries(reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX idx_entries_source ON accounting.journal_entries(source_type, source_id);
CREATE INDEX idx_entries_date ON accounting.journal_entries(tenant_id, entry_date);

CREATE TABLE accounting.journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  entry_id UUID NOT NULL REFERENCES accounting.journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounting.accounts(id),
  debit NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX idx_lines_entry ON accounting.journal_lines(entry_id);
CREATE INDEX idx_lines_account ON accounting.journal_lines(account_id);
CREATE INDEX idx_lines_tenant ON accounting.journal_lines(tenant_id);

ALTER TABLE accounting.expenses ADD COLUMN account_id UUID REFERENCES accounting.accounts(id);
CREATE INDEX idx_expenses_account ON accounting.expenses(account_id);

ALTER TABLE accounting.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.journal_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON accounting.accounts FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.journal_entries FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.journal_lines FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));

-- Accounts cannot be deleted, and the ledger can only be written through the functions below.
GRANT SELECT ON accounting.accounts, accounting.journal_entries, accounting.journal_lines TO authenticated;
GRANT INSERT (tenant_id, code, name, type) ON accounting.accounts TO authenticated;
GRANT UPDATE (name, is_active) ON accounting.accounts TO authenticated;

CREATE FUNCTION accounting.seed_chart(p_tenant UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system)
  VALUES
    (p_tenant, '1000', 'Cash', 'asset', true),
    (p_tenant, '1200', 'Accounts Receivable', 'asset', true),
    (p_tenant, '2000', 'Accounts Payable', 'liability', true),
    (p_tenant, '3000', 'Owner''s Equity', 'equity', true),
    (p_tenant, '3100', 'Retained Earnings', 'equity', true),
    (p_tenant, '4000', 'Sales Revenue', 'revenue', true),
    (p_tenant, '5000', 'Cost of Goods Sold', 'expense', true),
    (p_tenant, '6000', 'General Expenses', 'expense', true)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$$;

CREATE FUNCTION accounting.seed_chart_for_new_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.seed_chart(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER seed_chart AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION accounting.seed_chart_for_new_tenant();

CREATE FUNCTION accounting.account_by_code(p_tenant UUID, p_code TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT id FROM accounting.accounts WHERE tenant_id = p_tenant AND code = p_code;
$$;

-- Every write to the ledger goes through here, so nothing unbalanced can be stored.
CREATE FUNCTION accounting.insert_entry(
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
BEGIN
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

  -- Keeps entry numbers gap-free when two postings race
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 0));
  SELECT coalesce(max(entry_number), 0) + 1 INTO next_number
    FROM accounting.journal_entries WHERE tenant_id = p_tenant;

  INSERT INTO accounting.journal_entries
      (tenant_id, entry_number, entry_date, memo, source_type, source_id, reversal_of)
    VALUES (p_tenant, next_number, p_date, p_memo, p_source, p_source_id, p_reversal_of)
    RETURNING id INTO new_id;

  INSERT INTO accounting.journal_lines (tenant_id, entry_id, account_id, debit, credit)
    SELECT p_tenant, new_id, (l->>'account_id')::uuid,
      round(coalesce((l->>'debit')::numeric, 0), 2),
      round(coalesce((l->>'credit')::numeric, 0), 2)
    FROM jsonb_array_elements(p_lines) l;

  RETURN new_id;
END;
$$;

CREATE FUNCTION accounting.reverse_entry(p_entry UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry accounting.journal_entries;
  swapped JSONB;
BEGIN
  SELECT * INTO entry FROM accounting.journal_entries WHERE id = p_entry;

  SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'debit', credit, 'credit', debit))
    INTO swapped
    FROM accounting.journal_lines WHERE entry_id = p_entry;

  RETURN accounting.insert_entry(
    entry.tenant_id, greatest(current_date, entry.entry_date), 'Reversal of #' || entry.entry_number || ': ' || entry.memo,
    entry.source_type, entry.source_id, entry.id, swapped
  );
END;
$$;

-- Makes the ledger match a document. Changes are posted as a reversal plus a new entry.
CREATE FUNCTION accounting.sync_source(
  p_tenant UUID, p_source TEXT, p_source_id UUID, p_date DATE, p_memo TEXT,
  p_debit UUID, p_credit UUID, p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  active UUID;
  active_date DATE;
  active_amount NUMERIC;
  active_debit UUID;
  active_credit UUID;
BEGIN
  SELECT e.id, e.entry_date INTO active, active_date
    FROM accounting.journal_entries e
    WHERE e.source_type = p_source AND e.source_id = p_source_id AND e.reversal_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM accounting.journal_entries r WHERE r.reversal_of = e.id);

  IF active IS NOT NULL THEN
    SELECT
      sum(debit),
      (array_agg(account_id) FILTER (WHERE debit > 0))[1],
      (array_agg(account_id) FILTER (WHERE credit > 0))[1]
    INTO active_amount, active_debit, active_credit
    FROM accounting.journal_lines WHERE entry_id = active;

    IF active_amount = p_amount AND active_debit = p_debit
       AND active_credit = p_credit AND active_date = p_date THEN
      RETURN;
    END IF;
    PERFORM accounting.reverse_entry(active);
  END IF;

  IF p_amount > 0 THEN
    PERFORM accounting.insert_entry(
      p_tenant, p_date, p_memo, p_source, p_source_id, NULL,
      jsonb_build_array(
        jsonb_build_object('account_id', p_debit, 'debit', p_amount),
        jsonb_build_object('account_id', p_credit, 'credit', p_amount)
      )
    );
  END IF;
END;
$$;

CREATE FUNCTION accounting.post_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  cash UUID := accounting.account_by_code(NEW.tenant_id, '1000');
  receivable UUID := accounting.account_by_code(NEW.tenant_id, '1200');
  sales UUID := accounting.account_by_code(NEW.tenant_id, '4000');
BEGIN
  PERFORM accounting.sync_source(
    NEW.tenant_id, 'invoice', NEW.id, NEW.created_at::date,
    'Invoice ' || NEW.invoice_number, receivable, sales,
    CASE WHEN NEW.status IN ('sent', 'paid') THEN NEW.amount ELSE 0 END
  );
  PERFORM accounting.sync_source(
    NEW.tenant_id, 'invoice_payment', NEW.id, coalesce(NEW.paid_at, now())::date,
    'Payment for invoice ' || NEW.invoice_number, cash, receivable,
    CASE WHEN NEW.status = 'paid' THEN NEW.amount ELSE 0 END
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER post_invoice AFTER INSERT OR UPDATE ON accounting.invoices
  FOR EACH ROW EXECUTE FUNCTION accounting.post_invoice();

CREATE FUNCTION accounting.protect_posted_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF OLD.status <> 'draft' AND EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Only draft invoices can be deleted. Void this invoice instead.';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER protect_posted_invoice BEFORE DELETE ON accounting.invoices
  FOR EACH ROW EXECUTE FUNCTION accounting.protect_posted_invoice();

CREATE FUNCTION accounting.prepare_expense()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  NEW.account_id := coalesce(NEW.account_id, accounting.account_by_code(NEW.tenant_id, '6000'));
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts
    WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id AND type = 'expense'
  ) THEN
    RAISE EXCEPTION 'Choose an expense account';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER prepare_expense BEFORE INSERT OR UPDATE ON accounting.expenses
  FOR EACH ROW EXECUTE FUNCTION accounting.prepare_expense();

CREATE FUNCTION accounting.post_expense()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  row_data accounting.expenses;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := OLD;
  ELSE
    row_data := NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = row_data.tenant_id) THEN
    RETURN NULL;
  END IF;
  PERFORM accounting.sync_source(
    row_data.tenant_id, 'expense', row_data.id, row_data.expense_date,
    'Expense: ' || coalesce(row_data.description, row_data.category, 'General'),
    row_data.account_id, accounting.account_by_code(row_data.tenant_id, '1000'),
    CASE WHEN TG_OP = 'DELETE' THEN 0 ELSE row_data.amount END
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER post_expense AFTER INSERT OR UPDATE OR DELETE ON accounting.expenses
  FOR EACH ROW EXECUTE FUNCTION accounting.post_expense();

CREATE FUNCTION accounting.create_journal_entry(p_tenant UUID, p_date DATE, p_memo TEXT, p_lines JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
  IF length(trim(coalesce(p_memo, ''))) = 0 THEN
    RAISE EXCEPTION 'A description is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    JOIN accounting.accounts a ON a.id = (l->>'account_id')::uuid
    WHERE NOT a.is_active
  ) THEN
    RAISE EXCEPTION 'That account is inactive';
  END IF;
  RETURN accounting.insert_entry(p_tenant, p_date, trim(p_memo), 'manual', NULL, NULL, p_lines);
END;
$$;

CREATE FUNCTION accounting.reverse_journal_entry(p_tenant UUID, p_entry UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry accounting.journal_entries;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Entry not found';
  END IF;

  SELECT * INTO entry FROM accounting.journal_entries WHERE id = p_entry AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found';
  END IF;
  IF entry.source_type <> 'manual' OR entry.reversal_of IS NOT NULL THEN
    RAISE EXCEPTION 'Only manual entries can be reversed here. Change the invoice or expense instead.';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting.journal_entries WHERE reversal_of = p_entry) THEN
    RAISE EXCEPTION 'This entry has already been reversed';
  END IF;

  RETURN accounting.reverse_entry(p_entry);
END;
$$;

CREATE FUNCTION accounting.trial_balance(p_tenant UUID, p_as_of DATE)
RETURNS TABLE (account_id UUID, code TEXT, name TEXT, type TEXT, debit NUMERIC, credit NUMERIC)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT a.id, a.code, a.name, a.type,
    coalesce(sum(l.debit) FILTER (WHERE e.id IS NOT NULL), 0),
    coalesce(sum(l.credit) FILTER (WHERE e.id IS NOT NULL), 0)
  FROM accounting.accounts a
  LEFT JOIN accounting.journal_lines l ON l.account_id = a.id
  LEFT JOIN accounting.journal_entries e ON e.id = l.entry_id AND e.entry_date <= p_as_of
  WHERE a.tenant_id = p_tenant
  GROUP BY a.id, a.code, a.name, a.type
  ORDER BY a.code;
$$;

-- Totals are worked out in the database, because API reads are capped at 1000 rows.
CREATE FUNCTION accounting.summary(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH inv AS (
    SELECT
      coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0) AS revenue,
      coalesce(sum(amount) FILTER (WHERE status = 'sent'), 0) AS outstanding,
      coalesce(sum(amount) FILTER (WHERE status = 'sent' AND due_date < current_date), 0) AS overdue,
      count(*) AS invoice_count
    FROM accounting.invoices WHERE tenant_id = p_tenant
  ), exp AS (
    SELECT coalesce(sum(amount), 0) AS total, count(*) AS expense_count
    FROM accounting.expenses WHERE tenant_id = p_tenant
  )
  SELECT json_build_object(
    'revenue', inv.revenue,
    'outstanding', inv.outstanding,
    'overdue', inv.overdue,
    'totalExpenses', exp.total,
    'netProfit', inv.revenue - exp.total,
    'invoiceCount', inv.invoice_count,
    'expenseCount', exp.expense_count
  ) FROM inv, exp;
$$;

CREATE FUNCTION accounting.account_ledger(p_tenant UUID, p_account UUID)
RETURNS TABLE (
  entry_id UUID, entry_number BIGINT, entry_date DATE, memo TEXT, source_type TEXT,
  debit NUMERIC, credit NUMERIC, balance NUMERIC
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT * FROM (
    SELECT e.id, e.entry_number, e.entry_date, e.memo, e.source_type, l.debit, l.credit,
      sum(l.debit - l.credit) OVER (ORDER BY e.entry_date, e.entry_number, l.id)
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    WHERE l.tenant_id = p_tenant AND l.account_id = p_account
  ) ledger
  ORDER BY entry_date DESC, entry_number DESC;
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA accounting FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.account_ledger(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.create_journal_entry(UUID, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.reverse_journal_entry(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.trial_balance(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION accounting.summary(UUID) TO authenticated;

-- Existing companies get a chart, and existing documents post to the ledger.
SELECT accounting.seed_chart(id) FROM public.tenants;
UPDATE accounting.expenses SET amount = amount;
UPDATE accounting.invoices SET amount = amount;

NOTIFY pgrst, 'reload schema';
