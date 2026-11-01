-- One person can run several companies. Companies form a group, trade with each other through
-- Due from and Due to accounts, and report together with intercompany amounts taken out.
-- Companies in a group are treated as fully owned: there are no minority interests.

CREATE OR REPLACE FUNCTION public.create_tenant(company_name text)
RETURNS public.tenants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  new_tenant public.tenants;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF length(trim(coalesce(company_name, ''))) = 0 THEN
    RAISE EXCEPTION 'Company name is required';
  END IF;
  IF (SELECT count(*) FROM public.tenant_members WHERE user_id = auth.uid() AND role = 'owner') >= 10 THEN
    RAISE EXCEPTION 'You can own up to 10 companies';
  END IF;
  INSERT INTO public.tenants (name) VALUES (trim(company_name)) RETURNING * INTO new_tenant;
  INSERT INTO public.tenant_members (tenant_id, user_id, role) VALUES (new_tenant.id, auth.uid(), 'owner');
  RETURN new_tenant;
END;
$$;

DROP FUNCTION public.accept_invite(UUID);

CREATE FUNCTION public.accept_invite(p_invite UUID)
RETURNS UUID
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
  IF EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = invite.tenant_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You are already in this company';
  END IF;

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (invite.tenant_id, auth.uid(), invite.role);
  UPDATE public.tenant_invites SET accepted_at = now() WHERE id = p_invite;
  RETURN invite.tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_invite(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.accept_invite(UUID) TO authenticated;

-- A foreign key only proves the row exists. This proves it belongs to the same company.
CREATE FUNCTION accounting.check_party_company()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  party UUID := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
BEGIN
  IF party IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_ARGV[0] = 'customer_id' THEN
    IF NOT EXISTS (SELECT 1 FROM accounting.customers WHERE id = party AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'Customer not found';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM accounting.vendors WHERE id = party AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Vendor not found';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION accounting.check_party_company() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER a_check_party BEFORE INSERT OR UPDATE OF customer_id ON accounting.invoices
  FOR EACH ROW EXECUTE FUNCTION accounting.check_party_company('customer_id');
CREATE TRIGGER a_check_party BEFORE INSERT OR UPDATE OF vendor_id ON accounting.bills
  FOR EACH ROW EXECUTE FUNCTION accounting.check_party_company('vendor_id');
CREATE TRIGGER a_check_party BEFORE INSERT OR UPDATE OF vendor_id ON accounting.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION accounting.check_party_company('vendor_id');
CREATE TRIGGER a_check_party BEFORE INSERT OR UPDATE OF customer_id ON accounting.recurring_invoices
  FOR EACH ROW EXECUTE FUNCTION accounting.check_party_company('customer_id');

-- Intercompany balances
CREATE OR REPLACE FUNCTION accounting.seed_chart(p_tenant uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
  VALUES
    (p_tenant, '1000', 'Cash', 'asset', true, true),
    (p_tenant, '1200', 'Accounts Receivable', 'asset', true, false),
    (p_tenant, '1300', 'Due from Group Companies', 'asset', true, false),
    (p_tenant, '1500', 'Fixed Assets', 'asset', true, false),
    (p_tenant, '1590', 'Accumulated Depreciation', 'asset', true, false),
    (p_tenant, '2000', 'Accounts Payable', 'liability', true, false),
    (p_tenant, '2100', 'Tax Payable', 'liability', true, false),
    (p_tenant, '2200', 'Deferred Revenue', 'liability', true, false),
    (p_tenant, '2300', 'Due to Group Companies', 'liability', true, false),
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

ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type = ANY (ARRAY[
  'manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note', 'bank', 'closing',
  'asset', 'depreciation', 'vendor_credit', 'revenue', 'intercompany'
]));

-- Groups. Reached only through the functions below.
CREATE TABLE accounting.company_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE accounting.group_companies (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES accounting.company_groups(id) ON DELETE CASCADE,
  added_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_group_companies_group ON accounting.group_companies(group_id);

-- One unit of the company's currency in the group's currency
CREATE TABLE accounting.group_rates (
  group_id UUID NOT NULL REFERENCES accounting.company_groups(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_date DATE NOT NULL,
  closing_rate NUMERIC(18, 8) NOT NULL CHECK (closing_rate > 0),
  average_rate NUMERIC(18, 8) NOT NULL CHECK (average_rate > 0),
  PRIMARY KEY (group_id, currency, rate_date)
);

-- from_tenant is the lender or seller, to_tenant the borrower or buyer
CREATE TABLE accounting.intercompany_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES accounting.company_groups(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('loan', 'charge', 'repayment')),
  from_tenant UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  to_tenant UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  from_amount NUMERIC(14, 2) NOT NULL CHECK (from_amount > 0),
  to_amount NUMERIC(14, 2) NOT NULL CHECK (to_amount > 0),
  memo TEXT NOT NULL,
  from_entry UUID REFERENCES accounting.journal_entries(id) ON DELETE SET NULL,
  to_entry UUID REFERENCES accounting.journal_entries(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  voided_at TIMESTAMP,
  CHECK (from_tenant <> to_tenant)
);
CREATE INDEX idx_intercompany_group ON accounting.intercompany_entries(group_id);
CREATE INDEX idx_intercompany_from ON accounting.intercompany_entries(from_tenant);
CREATE INDEX idx_intercompany_to ON accounting.intercompany_entries(to_tenant);

ALTER TABLE accounting.company_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.group_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.group_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.intercompany_entries ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON accounting.group_companies
  FOR EACH ROW EXECUTE FUNCTION accounting.audit_row();

-- A group mixes several companies' books, so it needs manager rights in every one of them
CREATE FUNCTION accounting.manages_group(p_group UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM accounting.group_companies c
    WHERE c.group_id = p_group AND NOT EXISTS (
      SELECT 1 FROM public.tenant_members m
      WHERE m.tenant_id = c.tenant_id AND m.user_id = auth.uid() AND m.role IN ('owner', 'admin')
    )
  );
$$;

CREATE FUNCTION accounting.require_group(p_tenant UUID)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group UUID;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  SELECT group_id INTO the_group FROM accounting.group_companies WHERE tenant_id = p_tenant;
  IF the_group IS NULL THEN
    RAISE EXCEPTION 'This company is not in a group';
  END IF;
  IF NOT accounting.manages_group(the_group) THEN
    RAISE EXCEPTION 'You need to be an owner or admin of every company in the group';
  END IF;
  RETURN the_group;
END;
$$;

CREATE FUNCTION accounting.group_rate(p_group UUID, p_currency TEXT, p_date DATE, p_average BOOLEAN)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found_rate NUMERIC;
BEGIN
  IF p_currency = (SELECT currency FROM accounting.company_groups WHERE id = p_group) THEN
    RETURN 1;
  END IF;

  SELECT CASE WHEN p_average THEN r.average_rate ELSE r.closing_rate END INTO found_rate
    FROM accounting.group_rates r
    WHERE r.group_id = p_group AND r.currency = p_currency AND r.rate_date <= p_date
    ORDER BY r.rate_date DESC LIMIT 1;
  IF found_rate IS NULL THEN
    RAISE EXCEPTION 'Add a % rate dated on or before %', p_currency, p_date;
  END IF;
  RETURN found_rate;
END;
$$;

CREATE FUNCTION accounting.create_group(p_tenant UUID, p_name TEXT, p_currency TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  new_id UUID;
BEGIN
  IF accounting.require_manager(p_tenant) <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can put a company in a group';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting.group_companies WHERE tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'This company is already in a group';
  END IF;
  IF length(trim(coalesce(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'Enter a group name';
  END IF;
  IF coalesce(upper(trim(p_currency)), '') !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three letter currency code';
  END IF;

  INSERT INTO accounting.company_groups (name, currency, created_by)
    VALUES (trim(p_name), upper(trim(p_currency)), auth.uid())
    RETURNING id INTO new_id;
  INSERT INTO accounting.group_companies (tenant_id, group_id) VALUES (p_tenant, new_id);
  RETURN new_id;
END;
$$;

CREATE FUNCTION accounting.add_group_company(p_tenant UUID, p_company UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group UUID := accounting.require_group(p_tenant);
BEGIN
  IF accounting.require_manager(p_company) <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can put a company in a group';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting.group_companies WHERE tenant_id = p_company) THEN
    RAISE EXCEPTION 'That company is already in a group';
  END IF;
  INSERT INTO accounting.group_companies (tenant_id, group_id) VALUES (p_company, the_group);
END;
$$;

CREATE FUNCTION accounting.remove_group_company(p_tenant UUID, p_company UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group UUID := accounting.require_group(p_tenant);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounting.group_companies WHERE tenant_id = p_company AND group_id = the_group) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM accounting.intercompany_entries
    WHERE group_id = the_group AND p_company IN (from_tenant, to_tenant) AND voided_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Void this company''s intercompany entries first';
  END IF;

  DELETE FROM accounting.group_companies WHERE tenant_id = p_company;
  DELETE FROM accounting.company_groups g
    WHERE g.id = the_group AND NOT EXISTS (SELECT 1 FROM accounting.group_companies WHERE group_id = g.id);
END;
$$;

CREATE FUNCTION accounting.save_group_rate(p_tenant UUID, p_currency TEXT, p_date DATE, p_closing NUMERIC, p_average NUMERIC)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group UUID := accounting.require_group(p_tenant);
  code TEXT := upper(trim(coalesce(p_currency, '')));
BEGIN
  IF code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three letter currency code';
  END IF;
  IF coalesce(p_closing, 0) <= 0 OR coalesce(p_average, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter both rates above zero';
  END IF;

  INSERT INTO accounting.group_rates (group_id, currency, rate_date, closing_rate, average_rate)
    VALUES (the_group, code, p_date, p_closing, p_average)
    ON CONFLICT (group_id, currency, rate_date)
    DO UPDATE SET closing_rate = excluded.closing_rate, average_rate = excluded.average_rate;
END;
$$;

-- What is still owed between two companies, in the lender's currency
CREATE FUNCTION accounting.intercompany_owed(p_group UUID, p_from UUID, p_to UUID)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(sum(CASE WHEN kind = 'repayment' THEN -from_amount ELSE from_amount END), 0)
  FROM accounting.intercompany_entries
  WHERE group_id = p_group AND from_tenant = p_from AND to_tenant = p_to AND voided_at IS NULL;
$$;

CREATE FUNCTION accounting.create_intercompany(
  p_tenant UUID, p_kind TEXT, p_from UUID, p_to UUID, p_date DATE, p_amount NUMERIC, p_rate NUMERIC,
  p_from_account UUID, p_to_account UUID, p_memo TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group UUID := accounting.require_group(p_tenant);
  amount NUMERIC := round(p_amount, 2);
  from_currency TEXT;
  to_currency TEXT;
  rate NUMERIC;
  other_amount NUMERIC;
  from_control UUID;
  to_control UUID;
  from_lines JSONB;
  to_lines JSONB;
  new_id UUID;
  from_id UUID;
  to_id UUID;
  note TEXT := trim(coalesce(p_memo, ''));
BEGIN
  IF p_kind NOT IN ('loan', 'charge', 'repayment') THEN
    RAISE EXCEPTION 'Choose a type';
  END IF;
  IF p_from = p_to THEN
    RAISE EXCEPTION 'Choose two different companies';
  END IF;
  IF (SELECT count(*) FROM accounting.group_companies WHERE group_id = the_group AND tenant_id IN (p_from, p_to)) <> 2 THEN
    RAISE EXCEPTION 'Both companies must be in the group';
  END IF;
  IF coalesce(amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an amount';
  END IF;
  IF length(note) = 0 THEN
    RAISE EXCEPTION 'Enter a description';
  END IF;

  from_currency := accounting.base_currency(p_from);
  to_currency := accounting.base_currency(p_to);
  IF from_currency = to_currency THEN
    rate := 1;
  ELSIF coalesce(p_rate, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter the rate from % to %', from_currency, to_currency;
  ELSE
    rate := p_rate;
  END IF;
  other_amount := round(amount * rate, 2);
  IF other_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount';
  END IF;

  IF p_kind = 'charge' THEN
    IF NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = p_from_account AND tenant_id = p_from AND type = 'revenue' AND is_active) THEN
      RAISE EXCEPTION 'Choose an income account for the seller';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = p_to_account AND tenant_id = p_to AND type = 'expense' AND is_active) THEN
      RAISE EXCEPTION 'Choose an expense account for the buyer';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = p_from_account AND tenant_id = p_from AND is_cash AND is_active)
       OR NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = p_to_account AND tenant_id = p_to AND is_cash AND is_active) THEN
      RAISE EXCEPTION 'Choose a cash or bank account for each company';
    END IF;
  END IF;

  -- Taken in a fixed order, so two opposite entries at once can't block each other
  PERFORM pg_advisory_xact_lock(hashtextextended(least(p_from, p_to)::text, 3));
  PERFORM pg_advisory_xact_lock(hashtextextended(greatest(p_from, p_to)::text, 3));

  IF p_kind = 'repayment' AND amount > accounting.intercompany_owed(the_group, p_from, p_to) THEN
    RAISE EXCEPTION 'That is more than the % still owed', accounting.intercompany_owed(the_group, p_from, p_to);
  END IF;

  from_control := accounting.account_by_code(p_from, '1300');
  to_control := accounting.account_by_code(p_to, '2300');

  IF p_kind = 'repayment' THEN
    from_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_from_account, 'debit', amount),
      jsonb_build_object('account_id', from_control, 'credit', amount)
    );
    to_lines := jsonb_build_array(
      jsonb_build_object('account_id', to_control, 'debit', other_amount),
      jsonb_build_object('account_id', p_to_account, 'credit', other_amount)
    );
  ELSE
    from_lines := jsonb_build_array(
      jsonb_build_object('account_id', from_control, 'debit', amount),
      jsonb_build_object('account_id', p_from_account, 'credit', amount)
    );
    to_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_to_account, 'debit', other_amount),
      jsonb_build_object('account_id', to_control, 'credit', other_amount)
    );
  END IF;

  INSERT INTO accounting.intercompany_entries
      (group_id, kind, from_tenant, to_tenant, entry_date, from_amount, to_amount, memo, created_by)
    VALUES (the_group, p_kind, p_from, p_to, p_date, amount, other_amount, note, auth.uid())
    RETURNING id INTO new_id;

  from_id := accounting.insert_entry(p_from, p_date, 'Intercompany: ' || note, 'intercompany', new_id, NULL, from_lines);
  to_id := accounting.insert_entry(p_to, p_date, 'Intercompany: ' || note, 'intercompany', new_id, NULL, to_lines);

  UPDATE accounting.intercompany_entries SET from_entry = from_id, to_entry = to_id WHERE id = new_id;
  RETURN new_id;
END;
$$;

CREATE FUNCTION accounting.void_intercompany(p_tenant UUID, p_entry UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group UUID := accounting.require_group(p_tenant);
  entry accounting.intercompany_entries;
BEGIN
  SELECT * INTO entry FROM accounting.intercompany_entries WHERE id = p_entry AND group_id = the_group FOR UPDATE;
  IF NOT FOUND OR entry.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only active entries can be voided';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(least(entry.from_tenant, entry.to_tenant)::text, 3));
  PERFORM pg_advisory_xact_lock(hashtextextended(greatest(entry.from_tenant, entry.to_tenant)::text, 3));

  IF entry.kind <> 'repayment'
     AND entry.from_amount > accounting.intercompany_owed(the_group, entry.from_tenant, entry.to_tenant) THEN
    RAISE EXCEPTION 'Void the repayments first';
  END IF;

  PERFORM accounting.reverse_entry(entry.from_entry);
  PERFORM accounting.reverse_entry(entry.to_entry);
  UPDATE accounting.intercompany_entries SET voided_at = now() WHERE id = p_entry;
END;
$$;

CREATE FUNCTION accounting.group_overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group accounting.company_groups;
  role_here TEXT := accounting.require_manager(p_tenant);
  addable JSON;
BEGIN
  SELECT coalesce(json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name), '[]'::json) INTO addable
    FROM public.tenant_members m
    JOIN public.tenants t ON t.id = m.tenant_id
    WHERE m.user_id = auth.uid() AND m.role = 'owner'
      AND NOT EXISTS (SELECT 1 FROM accounting.group_companies c WHERE c.tenant_id = m.tenant_id);

  SELECT g.* INTO the_group
    FROM accounting.company_groups g
    JOIN accounting.group_companies c ON c.group_id = g.id
    WHERE c.tenant_id = p_tenant;

  IF NOT FOUND THEN
    RETURN json_build_object('group', NULL, 'role', role_here, 'base', accounting.base_currency(p_tenant), 'addable', addable);
  END IF;

  IF NOT accounting.manages_group(the_group.id) THEN
    RETURN json_build_object('group', json_build_object('name', the_group.name), 'access', false);
  END IF;

  RETURN json_build_object(
    'access', true,
    'role', role_here,
    'addable', addable,
    'group', json_build_object('id', the_group.id, 'name', the_group.name, 'currency', the_group.currency),
    'companies', (
      SELECT json_agg(json_build_object(
        'id', t.id, 'name', t.name, 'currency', accounting.base_currency(t.id),
        'accounts', (
          SELECT coalesce(json_agg(json_build_object('id', a.id, 'code', a.code, 'name', a.name, 'type', a.type, 'is_cash', a.is_cash) ORDER BY a.code), '[]'::json)
          FROM accounting.accounts a
          WHERE a.tenant_id = t.id AND a.is_active AND (a.is_cash OR a.type IN ('revenue', 'expense'))
        )
      ) ORDER BY t.name)
      FROM accounting.group_companies c JOIN public.tenants t ON t.id = c.tenant_id
      WHERE c.group_id = the_group.id
    ),
    'rates', (
      SELECT coalesce(json_agg(r ORDER BY r.rate_date DESC, r.currency), '[]'::json)
      FROM (
        SELECT currency, rate_date, closing_rate, average_rate
        FROM accounting.group_rates WHERE group_id = the_group.id
        ORDER BY rate_date DESC LIMIT 50
      ) r
    ),
    'entries', (
      SELECT coalesce(json_agg(e ORDER BY e.entry_date DESC, e.created_at DESC), '[]'::json)
      FROM (
        SELECT i.id, i.kind, i.entry_date, i.from_amount, i.to_amount, i.memo, i.voided_at, i.created_at,
          f.name AS from_name, t.name AS to_name, i.from_tenant, i.to_tenant
        FROM accounting.intercompany_entries i
        JOIN public.tenants f ON f.id = i.from_tenant
        JOIN public.tenants t ON t.id = i.to_tenant
        WHERE i.group_id = the_group.id
        ORDER BY i.entry_date DESC, i.created_at DESC LIMIT 200
      ) e
    )
  );
END;
$$;

-- Income and expenses at the average rate. Intercompany charges come out of both sides.
CREATE FUNCTION accounting.consolidated_pl(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group UUID := accounting.require_group(p_tenant);
  result JSON;
BEGIN
  WITH members AS (
    SELECT c.tenant_id, t.name AS company, accounting.base_currency(c.tenant_id) AS currency,
      accounting.group_rate(the_group, accounting.base_currency(c.tenant_id), p_to, true) AS rate
    FROM accounting.group_companies c JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.group_id = the_group
  ), lines AS (
    SELECT m.tenant_id, a.code, a.name, a.type,
      round(sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE l.debit - l.credit END) * m.rate, 2) AS amount,
      round(coalesce(sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE l.debit - l.credit END)
        FILTER (WHERE e.source_type = 'intercompany'), 0) * m.rate, 2) AS eliminated
    FROM members m
    JOIN accounting.journal_lines l ON l.tenant_id = m.tenant_id
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE a.type IN ('revenue', 'expense') AND e.entry_date BETWEEN p_from AND p_to AND e.source_type <> 'closing'
    GROUP BY m.tenant_id, m.rate, a.code, a.name, a.type
  ), rows AS (
    SELECT code, min(name) AS name, type, json_object_agg(tenant_id, amount) AS amounts,
      sum(eliminated) AS elimination, sum(amount) - sum(eliminated) AS total
    FROM lines
    GROUP BY code, type
    HAVING bool_or(amount <> 0 OR eliminated <> 0)
  ), totals AS (
    SELECT
      coalesce(sum(total) FILTER (WHERE type = 'revenue'), 0) AS revenue,
      coalesce(sum(total) FILTER (WHERE type = 'expense'), 0) AS expenses,
      coalesce(sum(elimination) FILTER (WHERE type = 'revenue'), 0)
        - coalesce(sum(elimination) FILTER (WHERE type = 'expense'), 0) AS difference
    FROM rows
  )
  SELECT json_build_object(
    'companies', (SELECT json_agg(json_build_object('id', tenant_id, 'name', company, 'currency', currency, 'rate', rate) ORDER BY company) FROM members),
    'revenue', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'revenue'), '[]'::json),
    'expenses', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'expense'), '[]'::json),
    'total_revenue', totals.revenue,
    'total_expenses', totals.expenses,
    'elimination_difference', totals.difference,
    'net_income', totals.revenue - totals.expenses + totals.difference
  ) INTO result FROM totals;

  RETURN result;
END;
$$;

-- Assets and liabilities at the closing rate, equity and earnings at the average rate.
-- What that leaves over is the translation difference, and it is zero when every company uses the group currency.
CREATE FUNCTION accounting.consolidated_bs(p_tenant UUID, p_as_of DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_group UUID := accounting.require_group(p_tenant);
  result JSON;
BEGIN
  WITH members AS (
    SELECT c.tenant_id, t.name AS company, accounting.base_currency(c.tenant_id) AS currency,
      accounting.group_rate(the_group, accounting.base_currency(c.tenant_id), p_as_of, false) AS closing_rate,
      accounting.group_rate(the_group, accounting.base_currency(c.tenant_id), p_as_of, true) AS average_rate
    FROM accounting.group_companies c JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.group_id = the_group
  ), balances AS (
    SELECT m.tenant_id, m.closing_rate, m.average_rate, a.code, a.name, a.type,
      sum(CASE WHEN a.type IN ('asset', 'expense') THEN l.debit - l.credit ELSE l.credit - l.debit END) AS balance
    FROM members m
    JOIN accounting.journal_lines l ON l.tenant_id = m.tenant_id
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE e.entry_date <= p_as_of
    GROUP BY m.tenant_id, m.closing_rate, m.average_rate, a.code, a.name, a.type
  ), lines AS (
    SELECT tenant_id, code, name, type,
      round(balance * CASE WHEN type = 'equity' THEN average_rate ELSE closing_rate END, 2) AS amount
    FROM balances
    WHERE type IN ('asset', 'liability', 'equity') AND balance <> 0
  ), earnings AS (
    SELECT tenant_id,
      round(coalesce(sum(CASE WHEN type = 'revenue' THEN balance ELSE -balance END), 0) * max(average_rate), 2) AS amount
    FROM balances
    WHERE type IN ('revenue', 'expense')
    GROUP BY tenant_id
  ), rows AS (
    SELECT code, min(name) AS name, type, json_object_agg(tenant_id, amount) AS amounts,
      CASE WHEN code IN ('1300', '2300') THEN sum(amount) ELSE 0 END AS elimination,
      CASE WHEN code IN ('1300', '2300') THEN 0 ELSE sum(amount) END AS total
    FROM lines
    GROUP BY code, type
  ), totals AS (
    SELECT
      coalesce((SELECT sum(total) FROM rows WHERE type = 'asset'), 0) AS assets,
      coalesce((SELECT sum(total) FROM rows WHERE type = 'liability'), 0) AS liabilities,
      coalesce((SELECT sum(total) FROM rows WHERE type = 'equity'), 0) AS equity,
      coalesce((SELECT sum(amount) FROM earnings), 0) AS earned,
      coalesce((SELECT sum(amount) FROM lines WHERE type = 'asset'), 0) AS gross_assets,
      coalesce((SELECT sum(amount) FROM lines WHERE type = 'liability'), 0) AS gross_liabilities,
      coalesce((SELECT sum(elimination) FROM rows WHERE code = '1300'), 0) AS due_from,
      coalesce((SELECT sum(elimination) FROM rows WHERE code = '2300'), 0) AS due_to
  ), plugs AS (
    SELECT *,
      gross_assets - gross_liabilities - equity - earned AS translation,
      due_to - due_from AS intercompany_difference
    FROM totals
  )
  SELECT json_build_object(
    'companies', (SELECT json_agg(json_build_object(
        'id', tenant_id, 'name', company, 'currency', currency, 'closing_rate', closing_rate, 'average_rate', average_rate
      ) ORDER BY company) FROM members),
    'assets', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'asset'), '[]'::json),
    'liabilities', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'liability'), '[]'::json),
    'equity', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'equity'), '[]'::json),
    'earnings', (SELECT coalesce(json_object_agg(tenant_id, amount), '{}'::json) FROM earnings),
    'total_earnings', plugs.earned,
    'translation', plugs.translation,
    'intercompany_difference', plugs.intercompany_difference,
    'total_assets', plugs.assets,
    'total_liabilities', plugs.liabilities,
    'total_equity', plugs.equity + plugs.earned + plugs.translation + plugs.intercompany_difference,
    'balanced', plugs.assets = plugs.liabilities + plugs.equity + plugs.earned + plugs.translation + plugs.intercompany_difference
  ) INTO result FROM plugs;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION
  accounting.manages_group(UUID),
  accounting.require_group(UUID),
  accounting.group_rate(UUID, TEXT, DATE, BOOLEAN),
  accounting.intercompany_owed(UUID, UUID, UUID),
  accounting.create_group(UUID, TEXT, TEXT),
  accounting.add_group_company(UUID, UUID),
  accounting.remove_group_company(UUID, UUID),
  accounting.save_group_rate(UUID, TEXT, DATE, NUMERIC, NUMERIC),
  accounting.create_intercompany(UUID, TEXT, UUID, UUID, DATE, NUMERIC, NUMERIC, UUID, UUID, TEXT),
  accounting.void_intercompany(UUID, UUID),
  accounting.group_overview(UUID),
  accounting.consolidated_pl(UUID, DATE, DATE),
  accounting.consolidated_bs(UUID, DATE)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  accounting.create_group(UUID, TEXT, TEXT),
  accounting.add_group_company(UUID, UUID),
  accounting.remove_group_company(UUID, UUID),
  accounting.save_group_rate(UUID, TEXT, DATE, NUMERIC, NUMERIC),
  accounting.create_intercompany(UUID, TEXT, UUID, UUID, DATE, NUMERIC, NUMERIC, UUID, UUID, TEXT),
  accounting.void_intercompany(UUID, UUID),
  accounting.group_overview(UUID),
  accounting.consolidated_pl(UUID, DATE, DATE),
  accounting.consolidated_bs(UUID, DATE)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
