-- Fixes from the live test of the accounting forms.
-- Cash flow puts fixed assets under investing, and a refund in another currency uses the rate on the day.

CREATE OR REPLACE FUNCTION accounting.cash_flow(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH cash_entries AS (
    SELECT e.id, e.source_type, sum(l.debit - l.credit) AS cash
    FROM accounting.journal_entries e
    JOIN accounting.journal_lines l ON l.entry_id = e.id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE e.tenant_id = p_tenant AND a.is_cash AND e.entry_date BETWEEN p_from AND p_to
    GROUP BY e.id
  ), lines AS (
    SELECT
      CASE
        WHEN a.code IN ('1500', '1590', '7000') THEN 'investing'
        WHEN c.source_type = 'credit_note' THEN 'operating'
        WHEN a.type IN ('revenue', 'expense') OR a.code IN ('1200', '2000', '2100') THEN 'operating'
        WHEN a.type = 'asset' THEN 'investing'
        ELSE 'financing'
      END AS activity,
      CASE
        WHEN a.code IN ('1500', '1590', '7000') THEN CASE WHEN c.cash > 0 THEN '1501' ELSE '1500' END
        WHEN c.source_type = 'credit_note' THEN '1201'
        ELSE a.code
      END AS code,
      CASE
        WHEN a.code IN ('1500', '1590', '7000') THEN CASE WHEN c.cash > 0 THEN 'Sold fixed assets' ELSE 'Bought fixed assets' END
        WHEN c.source_type = 'credit_note' THEN 'Refunded to customers'
        WHEN a.code = '1200' THEN 'Received from customers'
        WHEN a.code = '2000' THEN 'Paid to vendors'
        ELSE a.name
      END AS name,
      l.credit - l.debit AS amount
    FROM accounting.journal_lines l
    JOIN cash_entries c ON c.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE NOT a.is_cash
  ), rows AS (
    SELECT activity, code, name, sum(amount) AS amount
    FROM lines
    GROUP BY activity, code, name
    HAVING sum(amount) <> 0
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

-- The sale comes off at the invoice's rate. The cash goes out at the rate on the refund date,
-- and the difference is an exchange gain or loss, the same as on a payment.
DROP FUNCTION accounting.create_refund(UUID, UUID, DATE, NUMERIC, UUID, TEXT);
DROP FUNCTION accounting.issue_credit(UUID, accounting.invoices, DATE, NUMERIC, TEXT, UUID);

CREATE FUNCTION accounting.issue_credit(
  p_tenant UUID, p_invoice accounting.invoices, p_date DATE, p_amount NUMERIC, p_reason TEXT, p_refund_account UUID,
  p_rate NUMERIC DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tax NUMERIC := round(p_amount * p_invoice.tax_amount / p_invoice.amount, 2);
  gross NUMERIC;
  cash_base NUMERIC;
  gain NUMERIC;
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
  cash_base := CASE WHEN p_refund_account IS NOT NULL
    THEN round(p_amount * coalesce(p_rate, p_invoice.exchange_rate), 2)
    ELSE gross
  END;
  gain := gross - cash_base;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 2));
  SELECT coalesce(max(substring(credit_number FROM '\d+$')::bigint), 0) + 1 INTO next_number
    FROM accounting.credit_notes WHERE tenant_id = p_tenant;
  number_text := 'CN-' || lpad(next_number::text, 4, '0');

  INSERT INTO accounting.credit_notes
      (tenant_id, invoice_id, credit_number, credit_date, amount, tax_amount, reason, refund_account_id, base_amount)
    VALUES (p_tenant, p_invoice.id, number_text, p_date, p_amount, tax, trim(p_reason), p_refund_account, gross)
    RETURNING id INTO new_id;

  entry_lines := jsonb_build_array(jsonb_build_object(
    'account_id', coalesce(p_refund_account, accounting.account_by_code(p_tenant, '1200')), 'credit', cash_base
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
  IF gain > 0 THEN
    entry_lines := entry_lines || jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '7100'), 'credit', gain);
  ELSIF gain < 0 THEN
    entry_lines := entry_lines || jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '7100'), 'debit', -gain);
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

CREATE FUNCTION accounting.create_refund(
  p_tenant UUID, p_invoice UUID, p_date DATE, p_amount NUMERIC, p_account UUID, p_reason TEXT, p_rate NUMERIC DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  invoice accounting.invoices;
  amount NUMERIC := round(p_amount, 2);
  rate NUMERIC;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO invoice FROM accounting.invoices WHERE id = p_invoice AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF coalesce(amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter an amount';
  END IF;
  IF amount > invoice.amount_paid THEN
    RAISE EXCEPTION 'That is more than the % paid on this invoice', invoice.amount_paid;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting.accounts WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active
  ) THEN
    RAISE EXCEPTION 'Choose a cash or bank account';
  END IF;

  IF invoice.currency = accounting.base_currency(p_tenant) THEN
    rate := 1;
  ELSIF coalesce(p_rate, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter the exchange rate on the refund date';
  ELSE
    rate := p_rate;
  END IF;

  RETURN accounting.issue_credit(p_tenant, invoice, p_date, amount, p_reason, p_account, rate);
END;
$$;

REVOKE ALL ON FUNCTION
  accounting.issue_credit(UUID, accounting.invoices, DATE, NUMERIC, TEXT, UUID, NUMERIC),
  accounting.create_refund(UUID, UUID, DATE, NUMERIC, UUID, TEXT, NUMERIC)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION accounting.create_refund(UUID, UUID, DATE, NUMERIC, UUID, TEXT, NUMERIC) TO authenticated;

-- Purchase orders show their number in the audit trail
CREATE OR REPLACE FUNCTION accounting.audit_row()
RETURNS trigger
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
        source_row->>'invoice_number', source_row->>'bill_number', source_row->>'credit_number', source_row->>'po_number',
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

NOTIFY pgrst, 'reload schema';
