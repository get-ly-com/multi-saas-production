-- Follow-up to 048: a line with no quantity or price (or a non-object line) now gets the plain
-- message instead of slipping past the check and failing later on a null total.
CREATE OR REPLACE FUNCTION accounting.prepare_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  home TEXT := accounting.base_currency(NEW.tenant_id);
  paid NUMERIC;
  credited NUMERIC;
  refunded NUMERIC;
  number_like CONSTANT TEXT := '^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$';
BEGIN
  IF jsonb_typeof(NEW.line_items) <> 'array' OR jsonb_array_length(NEW.line_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one line item';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    WHERE NOT coalesce(jsonb_typeof(l) = 'object'
       AND jsonb_typeof(l->'quantity') IN ('number', 'string') AND jsonb_typeof(l->'unit_price') IN ('number', 'string')
       AND (l->>'quantity') ~ number_like AND (l->>'unit_price') ~ number_like, false)
  ) THEN
    RAISE EXCEPTION 'Each line needs a quantity and a unit price that are numbers';
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

    -- The next INV-0001 style number, under the same lock every invoice-creating function takes
    NEW.invoice_number := nullif(btrim(NEW.invoice_number), '');
    IF NEW.invoice_number IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 7));
      SELECT 'INV-' || lpad((coalesce(max(substring(i.invoice_number FROM '^INV-(\d+)$')::bigint), 0) + 1)::text, 4, '0')
        INTO NEW.invoice_number
        FROM accounting.invoices i WHERE i.tenant_id = NEW.tenant_id;
    ELSIF EXISTS (SELECT 1 FROM accounting.invoices i WHERE i.tenant_id = NEW.tenant_id AND i.invoice_number = NEW.invoice_number) THEN
      RAISE EXCEPTION 'Invoice number % is already used', NEW.invoice_number;
    END IF;
  ELSE
    NEW.tenant_id := OLD.tenant_id;
    NEW.invoice_number := OLD.invoice_number;
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

  -- The customer's name and email always come from the customer record, never typed in
  IF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    SELECT name, email INTO NEW.customer_name, NEW.customer_email
      FROM accounting.customers WHERE id = NEW.customer_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found';
    END IF;
  ELSIF NEW.customer_name IS DISTINCT FROM OLD.customer_name OR NEW.customer_email IS DISTINCT FROM OLD.customer_email THEN
    SELECT c.name, c.email INTO NEW.customer_name, NEW.customer_email
      FROM accounting.customers c WHERE c.id = NEW.customer_id AND c.tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      NEW.customer_name := OLD.customer_name;
      NEW.customer_email := OLD.customer_email;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
