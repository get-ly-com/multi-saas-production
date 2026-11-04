-- Run after supabase-migration-048.
-- Online invoice payments by card (Stripe Checkout).
--
-- A company picks the bank or clearing account card payments land in. Each invoice can have one
-- payment link, found by a random token. When the customer clicks "Pay now", the accounting
-- service starts a Stripe Checkout session for the balance and saves it here. When Stripe says
-- the session is paid, the payment is recorded once per session with the usual record_payment,
-- so the ledger posts the same way as a payment entered by hand.
--
-- The Stripe keys never live in the database. The public steps (looking up a link, saving a
-- session, recording a paid session) are only open to the service role, which only the
-- accounting service holds, so nobody can mark an invoice paid with the public anon key.

-- ---------------------------------------------------------------------------
-- Setting: where card payments land
-- ---------------------------------------------------------------------------
ALTER TABLE accounting.settings
  ADD COLUMN online_payment_account_id UUID REFERENCES accounting.accounts(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Payment links and checkout sessions
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL UNIQUE REFERENCES accounting.invoices(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
  created_by UUID,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX payment_links_tenant ON accounting.payment_links (tenant_id);

CREATE TABLE accounting.online_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES accounting.invoices(id) ON DELETE CASCADE,
  link_id UUID NOT NULL REFERENCES accounting.payment_links(id) ON DELETE CASCADE,
  -- Stripe's checkout session id. Recording is keyed on it, so a payment is never recorded twice.
  session_id TEXT NOT NULL UNIQUE CHECK (length(session_id) BETWEEN 10 AND 255),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- open: waiting for the customer. paid: recorded. review: money came in but could not be
  -- recorded automatically (for example the invoice was already paid), so a person checks it.
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'review')),
  payment_id UUID UNIQUE REFERENCES accounting.payments(id) ON DELETE SET NULL,
  reference TEXT,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  paid_at TIMESTAMP
);
CREATE INDEX online_payments_invoice ON accounting.online_payments (invoice_id);
CREATE INDEX online_payments_tenant ON accounting.online_payments (tenant_id);
CREATE INDEX online_payments_link ON accounting.online_payments (link_id);

ALTER TABLE accounting.payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.online_payments ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['accounting.payment_links', 'accounting.online_payments'] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_rows ON %s FOR SELECT TO authenticated
         USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))',
      target
    );
    EXECUTE format('GRANT SELECT ON %s TO authenticated', target);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Signed-in functions
-- ---------------------------------------------------------------------------
CREATE FUNCTION accounting.set_online_payment_account(p_tenant UUID, p_account UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF p_account IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM accounting.accounts WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active
  ) THEN
    RAISE EXCEPTION 'Choose a cash or bank account';
  END IF;
  INSERT INTO accounting.settings (tenant_id, online_payment_account_id) VALUES (p_tenant, p_account)
    ON CONFLICT (tenant_id) DO UPDATE SET online_payment_account_id = p_account, updated_at = now();
END;
$$;

-- The invoice's payment link token, made the first time it is asked for
CREATE FUNCTION accounting.payment_link_for(p_tenant UUID, p_invoice UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  found_token TEXT;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO invoice FROM accounting.invoices WHERE id = p_invoice AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF invoice.status NOT IN ('sent', 'partial')
     OR invoice.amount - invoice.amount_paid - invoice.amount_credited <= 0 THEN
    RAISE EXCEPTION 'Only sent invoices with a balance can be paid online';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.settings s
    JOIN accounting.accounts a ON a.id = s.online_payment_account_id AND a.tenant_id = s.tenant_id
    WHERE s.tenant_id = p_tenant AND a.is_cash AND a.is_active
  ) THEN
    RAISE EXCEPTION 'Choose the account card payments go into first';
  END IF;

  SELECT token INTO found_token FROM accounting.payment_links WHERE invoice_id = p_invoice;
  IF found_token IS NULL THEN
    INSERT INTO accounting.payment_links (tenant_id, invoice_id, token, created_by)
      VALUES (p_tenant, p_invoice, encode(extensions.gen_random_bytes(32), 'hex'), auth.uid())
      ON CONFLICT (invoice_id) DO NOTHING;
    SELECT token INTO found_token FROM accounting.payment_links WHERE invoice_id = p_invoice;
  END IF;
  RETURN found_token;
END;
$$;

-- ---------------------------------------------------------------------------
-- Public steps (service role only)
-- ---------------------------------------------------------------------------
-- What the customer sees on the pay page. NULL when the link is unknown.
CREATE FUNCTION accounting.pay_link_info(p_token TEXT)
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT json_build_object(
    'company', t.name,
    'invoice_number', i.invoice_number,
    'customer_name', i.customer_name,
    'invoice_date', i.invoice_date,
    'due_date', i.due_date,
    'currency', i.currency,
    'amount', i.amount,
    'balance', CASE WHEN i.status IN ('sent', 'partial') THEN greatest(i.amount - i.amount_paid - i.amount_credited, 0) ELSE 0 END,
    'status', CASE
      WHEN i.status = 'void' THEN 'void'
      WHEN i.status = 'paid' OR i.amount - i.amount_paid - i.amount_credited <= 0 THEN 'paid'
      WHEN i.status IN ('sent', 'partial') THEN 'open'
      ELSE 'closed' END,
    'account_ready', EXISTS (
      SELECT 1 FROM accounting.settings s
      JOIN accounting.accounts a ON a.id = s.online_payment_account_id AND a.tenant_id = s.tenant_id
      WHERE s.tenant_id = l.tenant_id AND a.is_cash AND a.is_active
    )
  )
  FROM accounting.payment_links l
  JOIN accounting.invoices i ON i.id = l.invoice_id AND i.tenant_id = l.tenant_id
  JOIN public.tenants t ON t.id = l.tenant_id
  WHERE p_token ~ '^[0-9a-f]{64}$' AND l.token = p_token;
$$;

-- Checks the invoice can be paid now and gives what the checkout session needs
CREATE FUNCTION accounting.pay_checkout_start(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  link accounting.payment_links;
  invoice accounting.invoices;
  balance NUMERIC;
BEGIN
  SELECT * INTO link FROM accounting.payment_links WHERE p_token ~ '^[0-9a-f]{64}$' AND token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This payment link is not available';
  END IF;
  SELECT * INTO invoice FROM accounting.invoices WHERE id = link.invoice_id AND tenant_id = link.tenant_id;
  balance := invoice.amount - invoice.amount_paid - invoice.amount_credited;
  IF invoice.status = 'void' THEN
    RAISE EXCEPTION 'This invoice was cancelled, so it can''t be paid';
  END IF;
  IF invoice.status = 'paid' OR balance <= 0 THEN
    RAISE EXCEPTION 'This invoice is already paid';
  END IF;
  IF invoice.status NOT IN ('sent', 'partial') THEN
    RAISE EXCEPTION 'This invoice can''t be paid online';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.settings s
    JOIN accounting.accounts a ON a.id = s.online_payment_account_id AND a.tenant_id = s.tenant_id
    WHERE s.tenant_id = link.tenant_id AND a.is_cash AND a.is_active
  ) THEN
    RAISE EXCEPTION 'Online payments aren''t set up yet';
  END IF;

  RETURN json_build_object(
    'link_id', link.id,
    'company', (SELECT name FROM public.tenants WHERE id = link.tenant_id),
    'invoice_number', invoice.invoice_number,
    'customer_email', invoice.customer_email,
    'currency', invoice.currency,
    'balance', balance
  );
END;
$$;

-- Saves a checkout session Stripe just made, for the balance it was made for
CREATE FUNCTION accounting.pay_checkout_saved(p_token TEXT, p_session TEXT, p_amount NUMERIC, p_currency TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  link accounting.payment_links;
BEGIN
  SELECT * INTO link FROM accounting.payment_links WHERE p_token ~ '^[0-9a-f]{64}$' AND token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This payment link is not available';
  END IF;
  INSERT INTO accounting.online_payments (tenant_id, invoice_id, link_id, session_id, amount, currency)
    VALUES (link.tenant_id, link.invoice_id, link.id, p_session, round(p_amount, 2), upper(p_currency));
END;
$$;

-- Records a paid checkout session as a payment on its invoice. Safe to call more than once for
-- the same session: only the first call records anything. Anything that stops it being recorded
-- automatically (amount changed, invoice already paid, books locked) leaves it for review, and
-- Stripe is told it arrived, so it does not keep sending it.
CREATE FUNCTION accounting.pay_checkout_paid(p_session TEXT, p_amount NUMERIC, p_currency TEXT, p_reference TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  online accounting.online_payments;
  invoice accounting.invoices;
  link accounting.payment_links;
  account UUID;
  rate NUMERIC;
  acting_user UUID;
  old_claims TEXT := current_setting('request.jwt.claims', true);
  old_sub TEXT := current_setting('request.jwt.claim.sub', true);
  new_payment UUID;
  problem TEXT;
  v_reference TEXT := left(nullif(trim(coalesce(p_reference, '')), ''), 120);
BEGIN
  SELECT * INTO online FROM accounting.online_payments WHERE session_id = p_session FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('status', 'unknown');
  END IF;
  IF online.status <> 'open' THEN
    RETURN json_build_object('status', online.status, 'payment_id', online.payment_id);
  END IF;

  SELECT * INTO invoice FROM accounting.invoices WHERE id = online.invoice_id AND tenant_id = online.tenant_id;
  SELECT * INTO link FROM accounting.payment_links WHERE id = online.link_id;
  SELECT s.online_payment_account_id INTO account FROM accounting.settings s
    JOIN accounting.accounts a ON a.id = s.online_payment_account_id AND a.tenant_id = s.tenant_id
    WHERE s.tenant_id = online.tenant_id AND a.is_cash AND a.is_active;

  IF upper(coalesce(p_currency, '')) <> online.currency OR round(coalesce(p_amount, 0), 2) <> online.amount THEN
    problem := format('The card payment was %s %s, not the %s %s asked for. Check it in Stripe and record it by hand.',
      upper(coalesce(p_currency, '?')), coalesce(p_amount, 0), online.currency, online.amount);
  ELSIF account IS NULL THEN
    problem := 'No account is chosen for card payments, so this one could not be recorded. Record it by hand.';
  END IF;

  IF problem IS NULL THEN
    IF invoice.currency = accounting.base_currency(online.tenant_id) THEN
      rate := 1;
    ELSE
      -- The latest saved rate, or the invoice's own rate when there is none
      SELECT r.rate INTO rate FROM accounting.exchange_rates r
        WHERE r.tenant_id = online.tenant_id AND r.currency = invoice.currency AND r.rate_date <= current_date
        ORDER BY r.rate_date DESC LIMIT 1;
      rate := coalesce(rate, invoice.exchange_rate);
    END IF;

    -- record_payment checks the caller is a member who can make changes. There is no signed-in
    -- person here, so it runs as the person who made the link, or else the company's owner or
    -- an admin. Only for this transaction.
    SELECT m.user_id INTO acting_user FROM public.tenant_members m
      WHERE m.tenant_id = online.tenant_id AND m.user_id = link.created_by AND m.role <> 'viewer';
    IF acting_user IS NULL THEN
      SELECT m.user_id INTO acting_user FROM public.tenant_members m
        WHERE m.tenant_id = online.tenant_id AND m.role IN ('owner', 'admin')
        ORDER BY (m.role = 'owner') DESC, m.created_at LIMIT 1;
    END IF;

    IF acting_user IS NULL THEN
      problem := 'Nobody in the company could record this card payment. Record it by hand.';
    ELSE
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', acting_user, 'role', 'authenticated', 'email', 'Online card payment')::text, true);
      PERFORM set_config('request.jwt.claim.sub', acting_user::text, true);
      BEGIN
        new_payment := accounting.record_payment(
          online.tenant_id, online.invoice_id, NULL, account, current_date, online.amount,
          'Card payment' || coalesce(' ' || v_reference, ''), rate
        );
      EXCEPTION WHEN raise_exception THEN
        problem := 'This card payment could not be recorded: ' || SQLERRM || '. Record it by hand.';
      END;
      PERFORM set_config('request.jwt.claims', coalesce(old_claims, ''), true);
      PERFORM set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
    END IF;
  END IF;

  IF new_payment IS NOT NULL THEN
    UPDATE accounting.online_payments
      SET status = 'paid', payment_id = new_payment, reference = v_reference, paid_at = now()
      WHERE id = online.id;
    RETURN json_build_object('status', 'paid', 'payment_id', new_payment);
  END IF;

  UPDATE accounting.online_payments
    SET status = 'review', note = left(problem, 500), reference = v_reference, paid_at = now()
    WHERE id = online.id;
  RETURN json_build_object('status', 'review');
END;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  accounting.set_online_payment_account(UUID, UUID),
  accounting.payment_link_for(UUID, UUID),
  accounting.pay_link_info(TEXT),
  accounting.pay_checkout_start(TEXT),
  accounting.pay_checkout_saved(TEXT, TEXT, NUMERIC, TEXT),
  accounting.pay_checkout_paid(TEXT, NUMERIC, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  accounting.set_online_payment_account(UUID, UUID),
  accounting.payment_link_for(UUID, UUID)
  TO authenticated;

GRANT EXECUTE ON FUNCTION
  accounting.pay_link_info(TEXT),
  accounting.pay_checkout_start(TEXT),
  accounting.pay_checkout_saved(TEXT, TEXT, NUMERIC, TEXT),
  accounting.pay_checkout_paid(TEXT, NUMERIC, TEXT, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';
