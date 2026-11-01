-- Quote to cash: quotes built from Inventory items become Accounting invoices.
-- Accepting a quote wins the deal. Stock leaves when the invoice is posted and returns if it is voided.

ALTER TABLE crm.companies ADD COLUMN customer_id UUID REFERENCES accounting.customers(id) ON DELETE SET NULL;
ALTER TABLE crm.contacts ADD COLUMN customer_id UUID REFERENCES accounting.customers(id) ON DELETE SET NULL;
CREATE INDEX idx_crm_companies_customer ON crm.companies (customer_id);
CREATE INDEX idx_crm_contacts_customer ON crm.contacts (customer_id);

ALTER TABLE inventory.movements ADD COLUMN invoice_id UUID REFERENCES accounting.invoices(id) ON DELETE SET NULL;
CREATE INDEX idx_movements_invoice ON inventory.movements (invoice_id);

CREATE TABLE crm.quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  quote_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined')),
  deal_id UUID REFERENCES crm.deals(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES crm.contacts(id) ON DELETE SET NULL,
  company_id UUID REFERENCES crm.companies(id) ON DELETE SET NULL,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  due_days INT NOT NULL DEFAULT 30 CHECK (due_days BETWEEN 0 AND 365),
  line_items JSONB NOT NULL,
  subtotal NUMERIC(14, 2) NOT NULL,
  tax_amount NUMERIC(14, 2) NOT NULL,
  total NUMERIC(14, 2) NOT NULL,
  notes TEXT,
  invoice_id UUID REFERENCES accounting.invoices(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, quote_number)
);
CREATE INDEX idx_crm_quotes_deal ON crm.quotes (deal_id);
CREATE INDEX idx_crm_quotes_contact ON crm.quotes (contact_id);
CREATE INDEX idx_crm_quotes_company ON crm.quotes (company_id);
CREATE INDEX idx_crm_quotes_invoice ON crm.quotes (invoice_id);
CREATE UNIQUE INDEX uq_crm_quotes_accepted_deal ON crm.quotes (deal_id) WHERE status = 'accepted';

ALTER TABLE crm.quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON crm.quotes FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
GRANT SELECT ON crm.quotes TO authenticated;

CREATE TRIGGER a_check_links BEFORE INSERT OR UPDATE ON crm.quotes FOR EACH ROW EXECUTE FUNCTION crm.check_links();

-- Works out how much stock an invoice should have taken and moves the difference,
-- so posting, editing and voiding all come out right however often this runs.
CREATE FUNCTION accounting.sync_invoice_stock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  move RECORD;
  stock inventory.items;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.line_items = OLD.line_items THEN
    RETURN NULL;
  END IF;

  FOR move IN
    WITH wanted AS (
      SELECT (l->>'item_id')::uuid AS item_id, sum((l->>'quantity')::numeric) AS quantity
      FROM jsonb_array_elements(CASE WHEN NEW.status IN ('sent', 'partial', 'paid') THEN NEW.line_items ELSE '[]'::jsonb END) l
      WHERE coalesce(l->>'item_id', '') <> ''
      GROUP BY 1
    ), taken AS (
      SELECT m.item_id, -sum(m.change) AS quantity
      FROM inventory.movements m WHERE m.invoice_id = NEW.id
      GROUP BY 1
    )
    SELECT coalesce(w.item_id, t.item_id) AS item_id, coalesce(w.quantity, 0) - coalesce(t.quantity, 0) AS more
    FROM wanted w FULL JOIN taken t ON t.item_id = w.item_id
  LOOP
    CONTINUE WHEN move.more = 0;
    IF move.more <> trunc(move.more) THEN
      RAISE EXCEPTION 'Stock items need whole quantities';
    END IF;

    SELECT * INTO stock FROM inventory.items WHERE id = move.item_id AND tenant_id = NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item not found';
    END IF;
    IF stock.quantity - move.more < 0 THEN
      RAISE EXCEPTION 'Only % of % in stock', stock.quantity, stock.name;
    END IF;

    UPDATE inventory.items SET quantity = quantity - move.more::int, updated_at = now() WHERE id = stock.id;
    INSERT INTO inventory.movements (tenant_id, item_id, change, reason, invoice_id)
      VALUES (NEW.tenant_id, stock.id, -move.more::int, 'Invoice ' || NEW.invoice_number, NEW.id);
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE TRIGGER y_sync_stock AFTER INSERT OR UPDATE ON accounting.invoices
  FOR EACH ROW EXECUTE FUNCTION accounting.sync_invoice_stock();

-- Totals here use the same rounding as an invoice, line by line
CREATE FUNCTION crm.save_quote(
  p_tenant UUID, p_quote UUID, p_deal UUID, p_contact UUID, p_company UUID,
  p_issue DATE, p_valid DATE, p_due_days INT, p_lines JSONB, p_notes TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  item JSONB;
  clean JSONB := '[]'::jsonb;
  quantity NUMERIC;
  price NUMERIC;
  discount NUMERIC;
  net NUMERIC;
  tax NUMERIC;
  stock UUID;
  tax_rate UUID;
  percent NUMERIC;
  sum_net NUMERIC := 0;
  sum_tax NUMERIC := 0;
  the_deal crm.deals;
  use_contact UUID := p_contact;
  use_company UUID := p_company;
  next_number BIGINT;
  new_id UUID := p_quote;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one line';
  END IF;
  IF p_valid < p_issue THEN
    RAISE EXCEPTION 'Valid until can''t be before the quote date';
  END IF;

  IF p_deal IS NOT NULL THEN
    SELECT * INTO the_deal FROM crm.deals WHERE id = p_deal AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Deal not found';
    END IF;
    use_contact := coalesce(use_contact, the_deal.contact_id);
    use_company := coalesce(use_company, the_deal.company_id);
  END IF;
  IF use_contact IS NULL AND use_company IS NULL THEN
    RAISE EXCEPTION 'Choose a contact or company';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    quantity := nullif(item->>'quantity', '')::numeric;
    price := nullif(item->>'unit_price', '')::numeric;
    discount := coalesce(nullif(item->>'discount', '')::numeric, 0);
    stock := nullif(item->>'item_id', '')::uuid;
    tax_rate := nullif(item->>'tax_rate_id', '')::uuid;

    IF length(trim(coalesce(item->>'description', ''))) = 0 OR coalesce(quantity, 0) <= 0 OR coalesce(price, -1) < 0 THEN
      RAISE EXCEPTION 'Each line needs a description, quantity and price';
    END IF;
    IF discount < 0 OR discount > 100 THEN
      RAISE EXCEPTION 'A discount must be between 0 and 100';
    END IF;
    IF stock IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM inventory.items i WHERE i.id = stock AND i.tenant_id = p_tenant) THEN
        RAISE EXCEPTION 'Item not found';
      END IF;
      IF quantity <> trunc(quantity) THEN
        RAISE EXCEPTION 'Stock items need whole quantities';
      END IF;
    END IF;

    percent := 0;
    IF tax_rate IS NOT NULL THEN
      SELECT t.rate INTO percent FROM accounting.tax_rates t WHERE t.id = tax_rate AND t.tenant_id = p_tenant;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Tax rate not found';
      END IF;
    END IF;

    net := round(quantity * price * (100 - discount) / 100, 2);
    tax := round(net * percent / 100, 2);
    sum_net := sum_net + net;
    sum_tax := sum_tax + tax;

    clean := clean || jsonb_build_object(
      'description', trim(item->>'description'), 'quantity', quantity, 'unit_price', price, 'discount', discount,
      'tax_rate_id', tax_rate, 'item_id', stock, 'net', net, 'tax', tax
    );
  END LOOP;

  IF new_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 9));
    SELECT coalesce(max(substring(q.quote_number FROM '^Q-(\d+)$')::bigint), 0) + 1 INTO next_number
      FROM crm.quotes q WHERE q.tenant_id = p_tenant;

    INSERT INTO crm.quotes (
      tenant_id, quote_number, deal_id, contact_id, company_id, issue_date, valid_until, due_days,
      line_items, subtotal, tax_amount, total, notes, created_by
    ) VALUES (
      p_tenant, 'Q-' || lpad(next_number::text, 4, '0'), p_deal, use_contact, use_company,
      coalesce(p_issue, current_date), p_valid, coalesce(p_due_days, 30),
      clean, sum_net, sum_tax, sum_net + sum_tax, nullif(trim(p_notes), ''), auth.uid()
    ) RETURNING id INTO new_id;
  ELSE
    UPDATE crm.quotes SET
      deal_id = p_deal, contact_id = use_contact, company_id = use_company,
      issue_date = coalesce(p_issue, issue_date), valid_until = p_valid, due_days = coalesce(p_due_days, 30),
      line_items = clean, subtotal = sum_net, tax_amount = sum_tax, total = sum_net + sum_tax,
      notes = nullif(trim(p_notes), ''), updated_at = now()
    WHERE id = p_quote AND tenant_id = p_tenant AND status = 'draft';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only draft quotes can be changed';
    END IF;
  END IF;

  RETURN new_id;
END;
$$;

CREATE FUNCTION crm.set_quote_status(p_tenant UUID, p_quote UUID, p_status TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  quote crm.quotes;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO quote FROM crm.quotes WHERE id = p_quote AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;
  IF NOT (
    (p_status = 'sent' AND quote.status = 'draft')
    OR (p_status = 'declined' AND quote.status = 'sent')
    OR (p_status = 'draft' AND quote.status IN ('sent', 'declined'))
  ) THEN
    RAISE EXCEPTION 'A % quote can''t become %', quote.status, p_status;
  END IF;

  UPDATE crm.quotes SET status = p_status, updated_at = now() WHERE id = p_quote;
END;
$$;

CREATE FUNCTION crm.delete_quote(p_tenant UUID, p_quote UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  DELETE FROM crm.quotes WHERE id = p_quote AND tenant_id = p_tenant AND status = 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only draft quotes can be deleted';
  END IF;
END;
$$;

-- Finds the Accounting customer for a CRM record, or creates one, and remembers the link
CREATE FUNCTION crm.customer_for_quote(p_quote crm.quotes)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_company crm.companies;
  the_contact crm.contacts;
  label TEXT;
  contact_email TEXT;
  phone_number TEXT;
  found_customer UUID;
BEGIN
  IF p_quote.contact_id IS NOT NULL THEN
    SELECT * INTO the_contact FROM crm.contacts WHERE id = p_quote.contact_id;
  END IF;
  IF p_quote.company_id IS NOT NULL THEN
    SELECT * INTO the_company FROM crm.companies WHERE id = p_quote.company_id;
  END IF;

  found_customer := coalesce(the_company.customer_id, the_contact.customer_id);
  IF found_customer IS NOT NULL AND EXISTS (SELECT 1 FROM accounting.customers c WHERE c.id = found_customer AND c.is_active) THEN
    RETURN found_customer;
  END IF;

  label := coalesce(the_company.name, the_contact.name);
  contact_email := the_contact.email;
  phone_number := coalesce(the_company.phone, the_contact.phone);
  IF label IS NULL THEN
    RAISE EXCEPTION 'Choose a contact or company';
  END IF;

  SELECT c.id INTO found_customer FROM accounting.customers c
    WHERE c.tenant_id = p_quote.tenant_id AND c.is_active
      AND (lower(c.name) = lower(label) OR (contact_email IS NOT NULL AND lower(c.email) = lower(contact_email)))
    ORDER BY (lower(c.name) = lower(label)) DESC
    LIMIT 1;

  IF found_customer IS NULL THEN
    INSERT INTO accounting.customers (tenant_id, name, email, phone)
      VALUES (p_quote.tenant_id, label, contact_email, phone_number)
      RETURNING id INTO found_customer;
  END IF;

  IF the_company.id IS NOT NULL THEN
    UPDATE crm.companies SET customer_id = found_customer WHERE id = the_company.id;
  ELSE
    UPDATE crm.contacts SET customer_id = found_customer WHERE id = the_contact.id;
  END IF;
  RETURN found_customer;
END;
$$;

-- A draft, so Accounting checks it before anything is posted or any stock moves
CREATE FUNCTION crm.invoice_from_quote(p_quote crm.quotes)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  next_number BIGINT;
  invoice accounting.invoices;
  lines JSONB;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
      'description', l->>'description',
      'quantity', (l->>'quantity')::numeric,
      'unit_price', CASE
        WHEN (l->>'discount')::numeric = 0 THEN (l->>'unit_price')::numeric
        ELSE round((l->>'net')::numeric / (l->>'quantity')::numeric, 10)
      END,
      'tax_rate_id', l->'tax_rate_id',
      'item_id', l->'item_id'
    ))
    INTO lines
    FROM jsonb_array_elements(p_quote.line_items) l;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_quote.tenant_id::text, 7));
  SELECT coalesce(max(substring(i.invoice_number FROM '^INV-(\d+)$')::bigint), 0) + 1 INTO next_number
    FROM accounting.invoices i WHERE i.tenant_id = p_quote.tenant_id;

  INSERT INTO accounting.invoices (tenant_id, invoice_number, customer_id, due_date, amount, line_items, description)
    VALUES (
      p_quote.tenant_id, 'INV-' || lpad(next_number::text, 4, '0'), crm.customer_for_quote(p_quote),
      current_date + p_quote.due_days, 0, lines, 'From quote ' || p_quote.quote_number
    )
    RETURNING * INTO invoice;

  IF invoice.amount <> p_quote.total THEN
    RAISE EXCEPTION 'The invoice total % does not match the quote total %', invoice.amount, p_quote.total;
  END IF;

  UPDATE crm.quotes SET invoice_id = invoice.id, updated_at = now() WHERE id = p_quote.id;

  INSERT INTO crm.activities (tenant_id, kind, subject, deal_id, contact_id, company_id)
    VALUES (p_quote.tenant_id, 'note', 'Invoice ' || invoice.invoice_number || ' drafted from ' || p_quote.quote_number,
      p_quote.deal_id, p_quote.contact_id, p_quote.company_id);

  RETURN invoice.id;
END;
$$;

CREATE FUNCTION crm.accept_quote(p_tenant UUID, p_quote UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  quote crm.quotes;
  won_stage UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO quote FROM crm.quotes WHERE id = p_quote AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;
  IF quote.status <> 'sent' THEN
    RAISE EXCEPTION 'Only sent quotes can be accepted';
  END IF;
  IF quote.valid_until < current_date THEN
    RAISE EXCEPTION 'This quote has expired. Move it back to draft and change its date.';
  END IF;
  IF quote.deal_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM crm.quotes q WHERE q.deal_id = quote.deal_id AND q.status = 'accepted'
  ) THEN
    RAISE EXCEPTION 'This deal already has an accepted quote';
  END IF;

  UPDATE crm.quotes SET status = 'accepted', accepted_at = now(), updated_at = now() WHERE id = p_quote;

  IF quote.deal_id IS NOT NULL THEN
    SELECT w.id INTO won_stage
      FROM crm.deals d
      JOIN crm.stages s ON s.id = d.stage_id
      JOIN crm.stages w ON w.pipeline_id = s.pipeline_id AND w.kind = 'won'
      WHERE d.id = quote.deal_id;
    UPDATE crm.deals SET stage_id = won_stage, value = quote.subtotal WHERE id = quote.deal_id;
  END IF;

  RETURN crm.invoice_from_quote(quote);
END;
$$;

-- For when the first draft invoice was deleted or voided
CREATE FUNCTION crm.reinvoice_quote(p_tenant UUID, p_quote UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  quote crm.quotes;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO quote FROM crm.quotes WHERE id = p_quote AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;
  IF quote.status <> 'accepted' THEN
    RAISE EXCEPTION 'Only accepted quotes can be invoiced';
  END IF;
  IF quote.invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM accounting.invoices i WHERE i.id = quote.invoice_id AND i.status <> 'void'
  ) THEN
    RAISE EXCEPTION 'This quote already has an invoice';
  END IF;

  RETURN crm.invoice_from_quote(quote);
END;
$$;

-- What a company or contact has been billed. Runs as the user, so policies apply.
CREATE FUNCTION crm.billing(p_tenant UUID, p_company UUID, p_contact UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH customers AS (
    SELECT customer_id FROM crm.companies WHERE tenant_id = p_tenant AND id = p_company
    UNION
    SELECT customer_id FROM crm.contacts WHERE tenant_id = p_tenant AND (id = p_contact OR company_id = p_company)
  ), posted AS (
    SELECT i.* FROM accounting.invoices i
    WHERE i.tenant_id = p_tenant AND i.status IN ('sent', 'partial', 'paid')
      AND i.customer_id IN (SELECT customer_id FROM customers WHERE customer_id IS NOT NULL)
  )
  SELECT json_build_object(
    'invoiced', (SELECT coalesce(sum(base_amount), 0) FROM posted),
    'outstanding', (SELECT coalesce(sum(base_amount - base_settled), 0) FROM posted),
    'invoices', (
      SELECT coalesce(json_agg(r ORDER BY r.invoice_date DESC, r.invoice_number DESC), '[]'::json) FROM (
        SELECT id, invoice_number, invoice_date, due_date, status, amount, currency,
          amount - amount_paid - amount_credited AS balance
        FROM posted ORDER BY invoice_date DESC, invoice_number DESC LIMIT 20
      ) r
    )
  );
$$;

REVOKE ALL ON FUNCTION
  accounting.sync_invoice_stock(),
  crm.save_quote(UUID, UUID, UUID, UUID, UUID, DATE, DATE, INT, JSONB, TEXT),
  crm.set_quote_status(UUID, UUID, TEXT),
  crm.delete_quote(UUID, UUID),
  crm.customer_for_quote(crm.quotes),
  crm.invoice_from_quote(crm.quotes),
  crm.accept_quote(UUID, UUID),
  crm.reinvoice_quote(UUID, UUID),
  crm.billing(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  crm.save_quote(UUID, UUID, UUID, UUID, UUID, DATE, DATE, INT, JSONB, TEXT),
  crm.set_quote_status(UUID, UUID, TEXT),
  crm.delete_quote(UUID, UUID),
  crm.accept_quote(UUID, UUID),
  crm.reinvoice_quote(UUID, UUID),
  crm.billing(UUID, UUID, UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
