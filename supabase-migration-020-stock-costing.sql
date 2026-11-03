-- Stock costing: every item carries its value at cost, using weighted average cost.
-- Stock bought on a bill comes in at the bill's cost, invoices take it out at the average
-- and post cost of goods sold, and the Inventory account always equals the stock value.

ALTER TABLE inventory.items
  ADD COLUMN stock_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN avg_cost NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0);

-- Cost is signed like the change: positive when value comes in, negative when it goes out
ALTER TABLE inventory.movements
  ADD COLUMN cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN bill_id UUID REFERENCES accounting.bills(id) ON DELETE SET NULL;
CREATE INDEX idx_movements_bill ON inventory.movements (bill_id);
CREATE INDEX idx_movements_item_created ON inventory.movements (item_id, created_at);

-- A revaluation changes the value without moving any stock
ALTER TABLE inventory.movements DROP CONSTRAINT movements_change_check;
ALTER TABLE inventory.movements ADD CONSTRAINT movements_change_check CHECK (change <> 0 OR cost <> 0);

CREATE OR REPLACE FUNCTION accounting.seed_chart(p_tenant uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
  VALUES
    (p_tenant, '1000', 'Cash', 'asset', true, true),
    (p_tenant, '1200', 'Accounts Receivable', 'asset', true, false),
    (p_tenant, '1300', 'Due from Group Companies', 'asset', true, false),
    (p_tenant, '1400', 'Inventory', 'asset', true, false),
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
    (p_tenant, '5100', 'Stock Adjustments', 'expense', true, false),
    (p_tenant, '6000', 'General Expenses', 'expense', true, false),
    (p_tenant, '6100', 'Depreciation Expense', 'expense', true, false),
    (p_tenant, '7000', 'Gain or Loss on Disposal', 'expense', true, false),
    (p_tenant, '7100', 'Exchange Gain or Loss', 'expense', true, false)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$$;
SELECT accounting.seed_chart(id) FROM public.tenants;

-- Two balanced lines moving p_amount from one account to another; nothing when it is zero
CREATE FUNCTION accounting.transfer_lines(p_tenant UUID, p_debit TEXT, p_credit TEXT, p_amount NUMERIC, p_cost_center UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN p_amount IS NULL OR p_amount = 0 THEN NULL ELSE jsonb_build_array(
    jsonb_build_object('account_id', accounting.account_by_code(p_tenant, CASE WHEN p_amount > 0 THEN p_debit ELSE p_credit END),
      'debit', abs(p_amount), 'cost_center_id', p_cost_center),
    jsonb_build_object('account_id', accounting.account_by_code(p_tenant, CASE WHEN p_amount > 0 THEN p_credit ELSE p_debit END),
      'credit', abs(p_amount), 'cost_center_id', p_cost_center)
  ) END;
$$;

-- The one place stock and its value change. A null cost means "at the average":
-- stock in at the last average cost, stock out at its share of the value on hand.
-- If an item runs out with value left over, the rest goes to Stock Adjustments so the
-- Inventory account and the stock value never drift apart.
CREATE FUNCTION inventory.move_stock(
  p_tenant UUID, p_item UUID, p_change INT, p_cost NUMERIC, p_reason TEXT, p_invoice UUID, p_bill UUID
)
RETURNS inventory.movements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  stock inventory.items;
  moved inventory.movements;
  value NUMERIC;
  left_over NUMERIC := 0;
BEGIN
  SELECT * INTO stock FROM inventory.items WHERE id = p_item AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found';
  END IF;
  IF stock.quantity + p_change < 0 THEN
    RAISE EXCEPTION 'Only % of % in stock', stock.quantity, stock.name;
  END IF;

  value := round(coalesce(p_cost, CASE
    WHEN p_change >= 0 THEN p_change * stock.avg_cost
    WHEN stock.quantity + p_change = 0 THEN -stock.stock_value
    ELSE stock.stock_value * p_change / stock.quantity
  END), 2);

  IF stock.quantity + p_change = 0 THEN
    left_over := stock.stock_value + value;
  END IF;

  UPDATE inventory.items SET
    quantity = quantity + p_change,
    stock_value = stock_value + value - left_over,
    avg_cost = CASE WHEN quantity + p_change > 0
      THEN greatest(round((stock_value + value) / (quantity + p_change), 4), 0) ELSE avg_cost END,
    updated_at = now()
  WHERE id = stock.id;

  INSERT INTO inventory.movements (tenant_id, item_id, change, cost, reason, invoice_id, bill_id)
    VALUES (p_tenant, stock.id, p_change, value, p_reason, p_invoice, p_bill)
    RETURNING * INTO moved;

  IF left_over <> 0 THEN
    PERFORM accounting.insert_entry(p_tenant, current_date, 'Stock value left when ' || stock.name || ' ran out',
      'stock_adjustment', moved.id, NULL, accounting.transfer_lines(p_tenant, '5100', '1400', left_over));
  END IF;
  RETURN moved;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.move_stock(UUID, UUID, INT, NUMERIC, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Deleting an item with value left would leave the Inventory account out of step
CREATE FUNCTION inventory.protect_valued_item()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- Deleting the whole company takes its books with it
  IF OLD.stock_value <> 0 AND EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Adjust % down to zero before deleting it, so its value comes off the books', OLD.name;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER protect_valued_item BEFORE DELETE ON inventory.items
  FOR EACH ROW EXECUTE FUNCTION inventory.protect_valued_item();

-- Counts, damage and opening stock. Stock bought from a supplier belongs on a bill instead.
DROP FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT);
CREATE FUNCTION inventory.adjust_stock(
  p_tenant UUID, p_item UUID, p_change INT, p_reason TEXT, p_unit_cost NUMERIC DEFAULT NULL, p_opening BOOLEAN DEFAULT false
)
RETURNS inventory.items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  moved inventory.movements;
  updated inventory.items;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_change IS NULL OR p_change = 0 THEN
    RAISE EXCEPTION 'Change must be a whole number, positive or negative';
  END IF;
  IF p_unit_cost IS NOT NULL AND (p_unit_cost < 0 OR p_unit_cost >= 1e10) THEN
    RAISE EXCEPTION 'Enter a valid unit cost';
  END IF;

  moved := inventory.move_stock(p_tenant, p_item, p_change,
    CASE WHEN p_change > 0 AND p_unit_cost IS NOT NULL THEN p_change * p_unit_cost END,
    nullif(btrim(p_reason), ''), NULL, NULL);

  IF moved.cost <> 0 THEN
    PERFORM accounting.insert_entry(p_tenant, current_date,
      CASE WHEN p_opening THEN 'Opening stock' ELSE 'Stock adjustment' END
        || coalesce(': ' || moved.reason, '') || ' (' || (SELECT name FROM inventory.items WHERE id = p_item) || ')',
      'stock_adjustment', moved.id, NULL,
      accounting.transfer_lines(p_tenant, '1400', CASE WHEN p_opening THEN '3000' ELSE '5100' END, moved.cost));
  END IF;

  SELECT * INTO updated FROM inventory.items WHERE id = p_item;
  RETURN updated;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT, NUMERIC, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT, NUMERIC, BOOLEAN) TO authenticated;

-- For stock that was on hand before costs were tracked. The change in value goes to equity,
-- like an opening balance, so only owners and admins can do it.
CREATE FUNCTION inventory.set_item_cost(p_tenant UUID, p_item UUID, p_unit_cost NUMERIC)
RETURNS inventory.items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  stock inventory.items;
  moved inventory.movements;
  difference NUMERIC;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF p_unit_cost IS NULL OR p_unit_cost < 0 OR p_unit_cost >= 1e10 THEN
    RAISE EXCEPTION 'Enter a valid unit cost';
  END IF;
  SELECT * INTO stock FROM inventory.items WHERE id = p_item AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found';
  END IF;

  difference := round(stock.quantity * p_unit_cost, 2) - stock.stock_value;
  IF difference <> 0 THEN
    UPDATE inventory.items SET stock_value = stock_value + difference, updated_at = now() WHERE id = stock.id;
    INSERT INTO inventory.movements (tenant_id, item_id, change, cost, reason)
      VALUES (p_tenant, stock.id, 0, difference, 'Cost set to ' || round(p_unit_cost, 4)::text)
      RETURNING * INTO moved;
    PERFORM accounting.insert_entry(p_tenant, current_date, 'Cost of stock on hand set (' || stock.name || ')',
      'stock_adjustment', moved.id, NULL, accounting.transfer_lines(p_tenant, '1400', '3000', difference));
  END IF;

  UPDATE inventory.items SET avg_cost = round(p_unit_cost, 4), updated_at = now() WHERE id = stock.id
    RETURNING * INTO stock;
  RETURN stock;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.set_item_cost(UUID, UUID, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.set_item_cost(UUID, UUID, NUMERIC) TO authenticated;

-- Invoices: stock out at the average, back in at the cost it left at, and cost of goods sold
-- kept in step with whatever the invoice has taken.
CREATE OR REPLACE FUNCTION accounting.sync_invoice_stock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  move RECORD;
  cost_of_sales NUMERIC;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.line_items = OLD.line_items
     AND NEW.invoice_date IS NOT DISTINCT FROM OLD.invoice_date AND NEW.cost_center_id IS NOT DISTINCT FROM OLD.cost_center_id THEN
    RETURN NULL;
  END IF;

  FOR move IN
    WITH wanted AS (
      SELECT (l->>'item_id')::uuid AS item_id, sum((l->>'quantity')::numeric) AS quantity
      FROM jsonb_array_elements(CASE WHEN NEW.status IN ('sent', 'partial', 'paid') THEN NEW.line_items ELSE '[]'::jsonb END) l
      WHERE coalesce(l->>'item_id', '') <> ''
      GROUP BY 1
    ), taken AS (
      SELECT m.item_id, -sum(m.change) AS quantity, -sum(m.cost) AS cost
      FROM inventory.movements m WHERE m.invoice_id = NEW.id
      GROUP BY 1
    )
    SELECT coalesce(w.item_id, t.item_id) AS item_id, coalesce(w.quantity, 0) - coalesce(t.quantity, 0) AS more,
      coalesce(t.quantity, 0) AS taken_quantity, coalesce(t.cost, 0) AS taken_cost
    FROM wanted w FULL JOIN taken t ON t.item_id = w.item_id
  LOOP
    CONTINUE WHEN move.more = 0;
    IF move.more <> trunc(move.more) THEN
      RAISE EXCEPTION 'Stock items need whole quantities';
    END IF;

    PERFORM inventory.move_stock(NEW.tenant_id, move.item_id, -move.more::int,
      CASE WHEN move.more < 0 THEN
        CASE WHEN -move.more = move.taken_quantity THEN move.taken_cost
          ELSE round(move.taken_cost * -move.more / move.taken_quantity, 2) END
      END,
      'Invoice ' || NEW.invoice_number, NEW.id, NULL);
  END LOOP;

  SELECT -coalesce(sum(cost), 0) INTO cost_of_sales FROM inventory.movements WHERE invoice_id = NEW.id;
  PERFORM accounting.sync_entry(NEW.tenant_id, 'invoice_cost', NEW.id, NEW.invoice_date,
    'Cost of sales, invoice ' || NEW.invoice_number,
    accounting.transfer_lines(NEW.tenant_id, '5000', '1400', cost_of_sales, NEW.cost_center_id));
  RETURN NULL;
END;
$$;

-- Bills: a line can name a stock item and a quantity. It always posts to Inventory,
-- and no other line can, so the account only moves with the stock.
CREATE OR REPLACE FUNCTION accounting.prepare_bill()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  home TEXT := accounting.base_currency(NEW.tenant_id);
  stock_account UUID := accounting.account_by_code(NEW.tenant_id, '1400');
  paid NUMERIC;
  next_number BIGINT;
BEGIN
  IF jsonb_typeof(NEW.line_items) <> 'array' OR jsonb_array_length(NEW.line_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one line';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN inventory.items i ON i.id::text = l->>'item_id' AND i.tenant_id = NEW.tenant_id
    WHERE coalesce(l->>'item_id', '') <> '' AND i.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Item not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    WHERE coalesce(l->>'item_id', '') <> ''
      AND (coalesce(l->>'quantity', '') !~ '^\d+$' OR (l->>'quantity')::numeric <= 0)
  ) THEN
    RAISE EXCEPTION 'Stock lines need a whole quantity';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    WHERE coalesce(l->>'item_id', '') = '' AND l->>'account_id' = stock_account::text
  ) THEN
    RAISE EXCEPTION 'Choose a stock item for lines on the Inventory account';
  END IF;
  SELECT jsonb_agg(CASE WHEN coalesce(l->>'item_id', '') <> ''
      THEN l || jsonb_build_object('account_id', stock_account, 'quantity', (l->>'quantity')::int)
      ELSE l - 'quantity' - 'item_id' END ORDER BY n)
    INTO NEW.line_items
    FROM jsonb_array_elements(NEW.line_items) WITH ORDINALITY x(l, n);

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.accounts a
      ON a.id::text = l->>'account_id' AND a.tenant_id = NEW.tenant_id
      AND a.type IN ('expense', 'asset') AND a.code NOT IN ('1200', '1590') AND NOT a.is_cash
    WHERE a.id IS NULL OR coalesce(round((l->>'amount')::numeric, 2), 0) <= 0
  ) THEN
    RAISE EXCEPTION 'Each line needs an expense or asset account and an amount';
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

  SELECT sum(base), sum(round(base * coalesce(rate, 0) / 100, 2))
  INTO NEW.subtotal, NEW.tax_amount
  FROM (
    SELECT round((l->>'amount')::numeric, 2) AS base, t.rate
    FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id'
  ) lines;
  NEW.amount := NEW.subtotal + NEW.tax_amount;

  -- Rounded the same way post_bill groups the debits, so the entry always balances.
  -- Each stock item is its own group, so its debit is exactly the value it adds.
  SELECT coalesce(sum(round(net * NEW.exchange_rate, 2)), 0) + round(NEW.tax_amount * NEW.exchange_rate, 2)
    INTO NEW.base_amount
    FROM (
      SELECT sum(round((l->>'amount')::numeric, 2)) AS net
      FROM jsonb_array_elements(NEW.line_items) l
      GROUP BY l->>'account_id', nullif(l->>'cost_center_id', ''), nullif(l->>'item_id', '')
    ) grouped;

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
    NEW.base_settled := 0;
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

  SELECT
    coalesce((SELECT sum(amount) FROM accounting.payments WHERE bill_id = NEW.id AND voided_at IS NULL), 0)
    + coalesce((SELECT sum(amount) FROM accounting.vendor_credits WHERE bill_id = NEW.id AND voided_at IS NULL), 0),
    coalesce((SELECT sum(control_amount) FROM accounting.payments WHERE bill_id = NEW.id AND voided_at IS NULL), 0)
    + coalesce((SELECT sum(base_amount) FROM accounting.vendor_credits WHERE bill_id = NEW.id AND voided_at IS NULL), 0)
  INTO paid, NEW.base_settled;

  IF paid > 0 AND (NEW.currency <> OLD.currency OR NEW.exchange_rate <> OLD.exchange_rate) THEN
    RAISE EXCEPTION 'The currency and rate cannot change once money has been recorded against this bill';
  END IF;
  NEW.amount_paid := paid;

  IF NEW.status = 'void' THEN
    IF paid > 0 THEN
      RAISE EXCEPTION 'Void this bill''s payments and vendor credits first';
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

CREATE OR REPLACE FUNCTION accounting.post_bill()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry_lines JSONB;
  tax_base NUMERIC := round(NEW.tax_amount * NEW.exchange_rate, 2);
BEGIN
  IF NEW.status IN ('open', 'partial', 'paid') THEN
    SELECT jsonb_agg(line) || jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '2000'), 'credit', NEW.base_amount
      ) INTO entry_lines
      FROM (
        SELECT jsonb_build_object(
            'account_id', l->>'account_id',
            'debit', round(sum(round((l->>'amount')::numeric, 2)) * NEW.exchange_rate, 2),
            'cost_center_id', nullif(l->>'cost_center_id', '')
          ) AS line
        FROM jsonb_array_elements(NEW.line_items) l
        GROUP BY l->>'account_id', nullif(l->>'cost_center_id', ''), nullif(l->>'item_id', '')
      ) grouped;
    IF tax_base > 0 THEN
      entry_lines := entry_lines || jsonb_build_object(
        'account_id', accounting.account_by_code(NEW.tenant_id, '2100'), 'debit', tax_base
      );
    END IF;
  END IF;

  PERFORM accounting.sync_entry(
    NEW.tenant_id, 'bill', NEW.id, NEW.bill_date, 'Bill ' || NEW.bill_number, entry_lines
  );
  RETURN NEW;
END;
$$;

-- Brings in what a posted bill bought, at the bill's cost in the base currency, and takes
-- it back out at that same cost if the bill is voided or changed.
CREATE FUNCTION accounting.sync_bill_stock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  move RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.line_items = OLD.line_items
     AND NEW.exchange_rate = OLD.exchange_rate THEN
    RETURN NULL;
  END IF;

  FOR move IN
    WITH wanted AS (
      SELECT (l->>'item_id')::uuid AS item_id, sum((l->>'quantity')::int) AS quantity,
        round(sum(round((l->>'amount')::numeric, 2)) * NEW.exchange_rate, 2) AS cost
      FROM jsonb_array_elements(CASE WHEN NEW.status IN ('open', 'partial', 'paid') THEN NEW.line_items ELSE '[]'::jsonb END) l
      WHERE coalesce(l->>'item_id', '') <> ''
      GROUP BY 1, nullif(l->>'cost_center_id', '')
    ), wanted_items AS (
      SELECT item_id, sum(quantity) AS quantity, sum(cost) AS cost FROM wanted GROUP BY 1
    ), received AS (
      SELECT m.item_id, sum(m.change) AS quantity, sum(m.cost) AS cost
      FROM inventory.movements m WHERE m.bill_id = NEW.id
      GROUP BY 1
    )
    SELECT coalesce(w.item_id, r.item_id) AS item_id,
      coalesce(w.quantity, 0) - coalesce(r.quantity, 0) AS more,
      coalesce(w.cost, 0) - coalesce(r.cost, 0) AS more_cost
    FROM wanted_items w FULL JOIN received r ON r.item_id = w.item_id
  LOOP
    CONTINUE WHEN move.more = 0 AND move.more_cost = 0;
    PERFORM inventory.move_stock(NEW.tenant_id, move.item_id, move.more::int, move.more_cost,
      'Bill ' || NEW.bill_number, NULL, NEW.id);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER y_sync_stock AFTER INSERT OR UPDATE ON accounting.bills
  FOR EACH ROW EXECUTE FUNCTION accounting.sync_bill_stock();
REVOKE EXECUTE ON FUNCTION accounting.sync_bill_stock() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION accounting.transfer_lines(UUID, TEXT, TEXT, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;

-- Gross profit: sales less cost of goods sold and stock adjustments
CREATE OR REPLACE FUNCTION accounting.profit_and_loss(p_tenant uuid, p_from date, p_to date)
RETURNS json
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
      coalesce(sum(amount) FILTER (WHERE type = 'expense'), 0) AS expenses,
      coalesce(sum(amount) FILTER (WHERE code IN ('5000', '5100')), 0) AS cost_of_sales
    FROM rows
  )
  SELECT json_build_object(
    'revenue', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'revenue'), '[]'::json),
    'expenses', coalesce((SELECT json_agg(r ORDER BY r.code) FROM rows r WHERE r.type = 'expense'), '[]'::json),
    'total_revenue', totals.revenue,
    'total_expenses', totals.expenses,
    'cost_of_sales', totals.cost_of_sales,
    'gross_profit', totals.revenue - totals.cost_of_sales,
    'net_income', totals.revenue - totals.expenses
  ) FROM totals;
$$;

-- Sales, cost and profit for each stock item on invoices dated in the range, in the base currency.
-- Credit notes are not split by item, so they are not taken off here.
CREATE FUNCTION inventory.product_profit(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Choose a start date before the end date';
  END IF;
  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Choose up to a year';
  END IF;

  RETURN (
    WITH invoices AS (
      SELECT id, line_items, exchange_rate FROM accounting.invoices
      WHERE tenant_id = p_tenant AND status IN ('sent', 'partial', 'paid') AND invoice_date BETWEEN p_from AND p_to
    ), sales AS (
      SELECT (l->>'item_id')::uuid AS item_id,
        sum((l->>'quantity')::numeric) AS sold,
        sum(round(round((l->>'quantity')::numeric * (l->>'unit_price')::numeric, 2) * i.exchange_rate, 2)) AS revenue
      FROM invoices i, jsonb_array_elements(i.line_items) l
      WHERE coalesce(l->>'item_id', '') <> ''
      GROUP BY 1
    ), costs AS (
      SELECT m.item_id, -sum(m.cost) AS cost
      FROM inventory.movements m JOIN invoices i ON i.id = m.invoice_id
      GROUP BY 1
    ), rows AS (
      SELECT it.id AS item_id, it.sku, it.name, coalesce(s.sold, 0) AS sold, coalesce(s.revenue, 0) AS revenue,
        coalesce(c.cost, 0) AS cost, coalesce(s.revenue, 0) - coalesce(c.cost, 0) AS profit,
        it.quantity AS on_hand, it.stock_value
      FROM sales s FULL JOIN costs c ON c.item_id = s.item_id
      JOIN inventory.items it ON it.id = coalesce(s.item_id, c.item_id) AND it.tenant_id = p_tenant
    )
    SELECT json_build_object(
      'from', p_from, 'to', p_to,
      'items', coalesce((SELECT json_agg(r ORDER BY r.profit DESC, r.name) FROM rows r), '[]'::json),
      'revenue', coalesce((SELECT sum(revenue) FROM rows), 0),
      'cost', coalesce((SELECT sum(cost) FROM rows), 0),
      'profit', coalesce((SELECT sum(profit) FROM rows), 0),
      'stock_value', coalesce((SELECT sum(stock_value) FROM inventory.items WHERE tenant_id = p_tenant), 0)
    )
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.product_profit(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.product_profit(UUID, DATE, DATE) TO authenticated;

-- What a deal's invoices earned after the cost of the stock they took
CREATE FUNCTION crm.deal_profit(p_tenant UUID, p_deal UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH invoices AS (
    SELECT i.id, round(i.subtotal * i.exchange_rate, 2) AS revenue
    FROM crm.quotes q JOIN accounting.invoices i ON i.id = q.invoice_id
    WHERE q.tenant_id = p_tenant AND q.deal_id = p_deal AND i.status IN ('sent', 'partial', 'paid')
  )
  SELECT json_build_object(
    'invoices', (SELECT count(*) FROM invoices),
    'revenue', coalesce((SELECT sum(revenue) FROM invoices), 0),
    'cost', coalesce((SELECT -sum(m.cost) FROM inventory.movements m JOIN invoices i ON i.id = m.invoice_id), 0)
  );
$$;
REVOKE EXECUTE ON FUNCTION crm.deal_profit(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.deal_profit(UUID, UUID) TO authenticated;
