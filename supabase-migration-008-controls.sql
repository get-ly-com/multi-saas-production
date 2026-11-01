-- Run after supabase-migration-007.
-- Roles, team invites, an audit trail, period locks and year-end close.
ALTER TABLE public.tenant_members DROP CONSTRAINT tenant_members_role_check;
UPDATE public.tenant_members SET role = 'accountant' WHERE role = 'member';
ALTER TABLE public.tenant_members ADD CONSTRAINT tenant_members_role_check
  CHECK (role IN ('owner', 'admin', 'accountant', 'viewer'));

-- Everyone in a company can read it. Viewers cannot write anything.
DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'accounting.invoices', 'accounting.expenses', 'accounting.accounts', 'accounting.customers',
    'accounting.vendors', 'accounting.bills', 'accounting.tax_rates',
    'crm.contacts', 'crm.deals', 'inventory.items'
  ] LOOP
    EXECUTE format('DROP POLICY tenant_rows ON %s', target);
    EXECUTE format(
      'CREATE POLICY tenant_rows ON %s FOR SELECT TO authenticated
         USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))',
      target
    );
    EXECUTE format(
      'CREATE POLICY tenant_writes ON %s FOR ALL TO authenticated
         USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid()) AND role <> ''viewer''))
         WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid()) AND role <> ''viewer''))',
      target
    );
  END LOOP;
END;
$$;

-- Every write function calls this, so it also keeps viewers out of them.
CREATE OR REPLACE FUNCTION accounting.require_member(p_tenant UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
BEGIN
  SELECT role INTO member_role FROM public.tenant_members
    WHERE tenant_id = p_tenant AND user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF member_role = 'viewer' THEN
    RAISE EXCEPTION 'Your role can only view this company';
  END IF;
END;
$$;

CREATE FUNCTION accounting.require_manager(p_tenant UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
BEGIN
  SELECT role INTO member_role FROM public.tenant_members
    WHERE tenant_id = p_tenant AND user_id = auth.uid();
  IF member_role IS NULL OR member_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owners and admins can do that';
  END IF;
  RETURN member_role;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.create_journal_entry(p_tenant UUID, p_date DATE, p_memo TEXT, p_lines JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
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

CREATE OR REPLACE FUNCTION accounting.reverse_journal_entry(p_tenant UUID, p_entry UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry accounting.journal_entries;
BEGIN
  PERFORM accounting.require_member(p_tenant);

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

CREATE OR REPLACE FUNCTION inventory.adjust_stock(p_tenant UUID, p_item UUID, p_change INT, p_reason TEXT)
RETURNS inventory.items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  updated inventory.items;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE inventory.items
    SET quantity = quantity + p_change, updated_at = now()
    WHERE id = p_item AND tenant_id = p_tenant
    RETURNING * INTO updated;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found';
  END IF;
  INSERT INTO inventory.movements (tenant_id, item_id, change, reason)
    VALUES (p_tenant, p_item, p_change, p_reason);
  RETURN updated;
END;
$$;

-- Period lock
CREATE TABLE accounting.settings (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  lock_date DATE,
  updated_at TIMESTAMP DEFAULT now()
);
ALTER TABLE accounting.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON accounting.settings FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
GRANT SELECT ON accounting.settings TO authenticated;

ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN ('manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note', 'bank', 'closing'));

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

-- A reversal lands in the first open day, so a closed period keeps its figures.
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

  SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'debit', credit, 'credit', debit))
    INTO swapped
    FROM accounting.journal_lines WHERE entry_id = p_entry;

  RETURN accounting.insert_entry(
    entry.tenant_id, greatest(current_date, entry.entry_date, locked_through + 1),
    'Reversal of #' || entry.entry_number || ': ' || entry.memo,
    entry.source_type, entry.source_id, entry.id, swapped
  );
END;
$$;

CREATE FUNCTION accounting.set_lock_date(p_tenant UUID, p_date DATE)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT := accounting.require_manager(p_tenant);
  current_lock DATE;
BEGIN
  SELECT lock_date INTO current_lock FROM accounting.settings WHERE tenant_id = p_tenant;

  IF p_date > current_date THEN
    RAISE EXCEPTION 'The lock date cannot be in the future';
  END IF;
  IF member_role <> 'owner' AND (p_date IS NULL OR p_date < current_lock) THEN
    RAISE EXCEPTION 'Only the owner can reopen a locked period';
  END IF;

  INSERT INTO accounting.settings (tenant_id, lock_date) VALUES (p_tenant, p_date)
    ON CONFLICT (tenant_id) DO UPDATE SET lock_date = p_date, updated_at = now();
END;
$$;

-- Moves the year's profit into Retained Earnings and locks the year.
CREATE FUNCTION accounting.close_year(p_tenant UUID, p_date DATE)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  current_lock DATE;
  entry_lines JSONB;
  total NUMERIC;
  retained UUID := accounting.account_by_code(p_tenant, '3100');
  new_id UUID;
BEGIN
  PERFORM accounting.require_manager(p_tenant);

  IF p_date IS NULL OR p_date > current_date THEN
    RAISE EXCEPTION 'Choose a year-end date that has passed';
  END IF;
  SELECT lock_date INTO current_lock FROM accounting.settings WHERE tenant_id = p_tenant;
  IF p_date <= current_lock THEN
    RAISE EXCEPTION 'That date is already locked';
  END IF;

  SELECT
    jsonb_agg(jsonb_build_object('account_id', account_id, 'debit', greatest(-net, 0), 'credit', greatest(net, 0))),
    sum(net)
  INTO entry_lines, total
  FROM (
    SELECT l.account_id, sum(l.debit - l.credit) AS net
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND a.type IN ('revenue', 'expense') AND e.entry_date <= p_date
    GROUP BY l.account_id
    HAVING sum(l.debit - l.credit) <> 0
  ) balances;

  IF entry_lines IS NULL THEN
    RAISE EXCEPTION 'There is nothing to close';
  END IF;
  IF total <> 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', retained, 'debit', greatest(total, 0), 'credit', greatest(-total, 0)
    );
  END IF;

  new_id := accounting.insert_entry(
    p_tenant, p_date, 'Year-end close to ' || p_date, 'closing', NULL, NULL, entry_lines
  );

  INSERT INTO accounting.settings (tenant_id, lock_date) VALUES (p_tenant, p_date)
    ON CONFLICT (tenant_id) DO UPDATE SET lock_date = p_date, updated_at = now();

  RETURN new_id;
END;
$$;

-- A closing entry is not income or expense, so these leave it out.
CREATE OR REPLACE FUNCTION accounting.profit_and_loss(p_tenant UUID, p_from DATE, p_to DATE)
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
      AND e.entry_date BETWEEN p_from AND p_to AND e.source_type <> 'closing'
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

-- Audit trail: written by triggers, and no one can edit or delete it.
CREATE TABLE accounting.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  row_id TEXT,
  label TEXT,
  action TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  user_id UUID,
  user_email TEXT,
  changes JSONB,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON accounting.audit_log(tenant_id, created_at DESC);

ALTER TABLE accounting.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY managers_read ON accounting.audit_log FOR SELECT TO authenticated
  USING (tenant_id IN (
    SELECT tenant_id FROM public.tenant_members
    WHERE user_id = (select auth.uid()) AND role IN ('owner', 'admin')
  ));
GRANT SELECT ON accounting.audit_log TO authenticated;

CREATE FUNCTION accounting.audit_row()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  source_row JSONB;
  change_set JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  source_row := coalesce(new_row, old_row);

  -- Skipped while a whole company is being deleted
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = (source_row->>'tenant_id')::uuid) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(key, jsonb_build_object('from', old_row->key, 'to', value)) INTO change_set
      FROM jsonb_each(new_row)
      WHERE key <> 'updated_at' AND value IS DISTINCT FROM old_row->key;
    IF change_set IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    change_set := source_row - 'tenant_id';
  END IF;

  INSERT INTO accounting.audit_log (tenant_id, table_name, row_id, label, action, user_id, user_email, changes)
    VALUES (
      (source_row->>'tenant_id')::uuid,
      TG_TABLE_NAME,
      coalesce(source_row->>'id', source_row->>'user_id', source_row->>'tenant_id'),
      coalesce(
        source_row->>'invoice_number', source_row->>'bill_number', source_row->>'credit_number',
        source_row->>'memo', source_row->>'name', source_row->>'description'
      ),
      lower(TG_OP),
      auth.uid(),
      auth.jwt()->>'email',
      change_set
    );
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'accounting.invoices', 'accounting.bills', 'accounting.expenses', 'accounting.customers',
    'accounting.vendors', 'accounting.accounts', 'accounting.tax_rates', 'accounting.payments',
    'accounting.credit_notes', 'accounting.journal_entries', 'accounting.bank_lines',
    'accounting.reconciliations', 'accounting.settings', 'public.tenant_members'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION accounting.audit_row()',
      target
    );
  END LOOP;
END;
$$;

-- Team. A person joins by signing up with the invited, confirmed email address.
CREATE TABLE public.tenant_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'accountant', 'viewer')),
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at TIMESTAMP NOT NULL DEFAULT now() + interval '14 days',
  accepted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX idx_invites_pending ON public.tenant_invites(tenant_id, email) WHERE accepted_at IS NULL;
CREATE INDEX idx_invites_email ON public.tenant_invites(email);
ALTER TABLE public.tenant_invites ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.team_overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  me_role TEXT;
BEGIN
  SELECT role INTO me_role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid();
  IF me_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;

  RETURN json_build_object(
    'role', me_role,
    'members', (
      SELECT json_agg(json_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role, 'is_me', m.user_id = auth.uid()) ORDER BY u.email)
      FROM public.tenant_members m JOIN auth.users u ON u.id = m.user_id
      WHERE m.tenant_id = p_tenant
    ),
    'invites', CASE WHEN me_role IN ('owner', 'admin') THEN coalesce((
      SELECT json_agg(json_build_object('id', i.id, 'email', i.email, 'role', i.role, 'expires_at', i.expires_at) ORDER BY i.created_at DESC)
      FROM public.tenant_invites i
      WHERE i.tenant_id = p_tenant AND i.accepted_at IS NULL AND i.expires_at > now()
    ), '[]'::json) ELSE '[]'::json END
  );
END;
$$;

CREATE FUNCTION public.invite_member(p_tenant UUID, p_email TEXT, p_role TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  me_role TEXT := accounting.require_manager(p_tenant);
  address TEXT := lower(trim(coalesce(p_email, '')));
  new_id UUID;
BEGIN
  IF address !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Enter a valid email address';
  END IF;
  IF p_role NOT IN ('admin', 'accountant', 'viewer') THEN
    RAISE EXCEPTION 'Choose a role';
  END IF;
  IF p_role = 'admin' AND me_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can invite an admin';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenant_members m JOIN auth.users u ON u.id = m.user_id
    WHERE m.tenant_id = p_tenant AND lower(u.email) = address
  ) THEN
    RAISE EXCEPTION 'That person is already on the team';
  END IF;

  DELETE FROM public.tenant_invites WHERE tenant_id = p_tenant AND email = address AND accepted_at IS NULL;
  INSERT INTO public.tenant_invites (tenant_id, email, role, invited_by)
    VALUES (p_tenant, address, p_role, auth.uid())
    RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE FUNCTION public.revoke_invite(p_tenant UUID, p_invite UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  DELETE FROM public.tenant_invites WHERE id = p_invite AND tenant_id = p_tenant AND accepted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite not found';
  END IF;
END;
$$;

CREATE FUNCTION public.set_member_role(p_tenant UUID, p_user UUID, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  me_role TEXT := accounting.require_manager(p_tenant);
  target_role TEXT;
BEGIN
  SELECT role INTO target_role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = p_user;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'Member not found';
  END IF;
  IF p_user = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own role';
  END IF;
  IF p_role NOT IN ('admin', 'accountant', 'viewer') THEN
    RAISE EXCEPTION 'Choose a role';
  END IF;
  IF target_role = 'owner' THEN
    RAISE EXCEPTION 'The owner''s role cannot be changed';
  END IF;
  IF me_role <> 'owner' AND (target_role = 'admin' OR p_role = 'admin') THEN
    RAISE EXCEPTION 'Only the owner can change admins';
  END IF;

  UPDATE public.tenant_members SET role = p_role WHERE tenant_id = p_tenant AND user_id = p_user;
END;
$$;

CREATE FUNCTION public.remove_member(p_tenant UUID, p_user UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  me_role TEXT := accounting.require_manager(p_tenant);
  target_role TEXT;
BEGIN
  SELECT role INTO target_role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = p_user;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'Member not found';
  END IF;
  IF p_user = auth.uid() THEN
    RAISE EXCEPTION 'You cannot remove yourself';
  END IF;
  IF target_role = 'owner' THEN
    RAISE EXCEPTION 'The owner cannot be removed';
  END IF;
  IF target_role = 'admin' AND me_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can remove an admin';
  END IF;

  DELETE FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = p_user;
END;
$$;

CREATE FUNCTION public.my_invites()
RETURNS TABLE (id UUID, company TEXT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT i.id, t.name, i.role
  FROM public.tenant_invites i
  JOIN public.tenants t ON t.id = i.tenant_id
  JOIN auth.users u ON u.id = auth.uid()
  WHERE i.email = lower(u.email) AND u.email_confirmed_at IS NOT NULL
    AND i.accepted_at IS NULL AND i.expires_at > now();
$$;

CREATE FUNCTION public.accept_invite(p_invite UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  invite public.tenant_invites;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  SELECT i.* INTO invite
    FROM public.tenant_invites i
    JOIN auth.users u ON u.id = auth.uid()
    WHERE i.id = p_invite AND i.email = lower(u.email) AND u.email_confirmed_at IS NOT NULL
      AND i.accepted_at IS NULL AND i.expires_at > now()
    FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite not found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_members WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You already belong to a company';
  END IF;

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (invite.tenant_id, auth.uid(), invite.role);
  UPDATE public.tenant_invites SET accepted_at = now() WHERE id = p_invite;
END;
$$;

REVOKE EXECUTE ON FUNCTION accounting.require_manager(UUID), accounting.audit_row(),
  accounting.set_lock_date(UUID, DATE), accounting.close_year(UUID, DATE),
  public.team_overview(UUID), public.invite_member(UUID, TEXT, TEXT), public.revoke_invite(UUID, UUID),
  public.set_member_role(UUID, UUID, TEXT), public.remove_member(UUID, UUID),
  public.my_invites(), public.accept_invite(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.set_lock_date(UUID, DATE), accounting.close_year(UUID, DATE),
  public.team_overview(UUID), public.invite_member(UUID, TEXT, TEXT), public.revoke_invite(UUID, UUID),
  public.set_member_role(UUID, UUID, TEXT), public.remove_member(UUID, UUID),
  public.my_invites(), public.accept_invite(UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
