-- Inventory, deeper: warehouses and moving stock between them, stock counts, categories, units
-- and barcodes, reorder suggestions that become draft purchase orders, and stock value on any date.
--
-- Cost stays one weighted average per item for the whole company. Stock held in each place is
-- tracked in stock_levels, and items.quantity is always the total of its levels. Moving stock
-- between places never touches the books, so the Inventory account still equals total stock value.
-- Every existing flow (bills, invoices, adjustments) keeps working and uses the main warehouse
-- unless a line names another place.

-- ---------------------------------------------------------------- tables

CREATE TABLE inventory.locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 80),
  is_main BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT locations_main_is_active CHECK (active OR NOT is_main)
);
CREATE UNIQUE INDEX locations_name_key ON inventory.locations (tenant_id, lower(name));
CREATE UNIQUE INDEX locations_one_main ON inventory.locations (tenant_id) WHERE is_main;

CREATE TABLE inventory.stock_levels (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory.items(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE CASCADE,
  quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (item_id, location_id)
);
CREATE INDEX idx_stock_levels_location ON inventory.stock_levels (location_id);
CREATE INDEX idx_stock_levels_tenant ON inventory.stock_levels (tenant_id);

CREATE TABLE inventory.transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  number INT NOT NULL,
  from_location UUID NOT NULL CONSTRAINT transfers_from_location_fkey REFERENCES inventory.locations(id) ON DELETE CASCADE,
  to_location UUID NOT NULL CONSTRAINT transfers_to_location_fkey REFERENCES inventory.locations(id) ON DELETE CASCADE,
  note TEXT CHECK (length(note) <= 500),
  created_by UUID,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE inventory.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 80),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_key ON inventory.categories (tenant_id, lower(name));

CREATE TABLE inventory.counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  number INT NOT NULL,
  location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE CASCADE,
  category_id UUID REFERENCES inventory.categories(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'cancelled')),
  note TEXT CHECK (length(note) <= 500),
  value_change NUMERIC(14, 2),
  created_by UUID,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  applied_by UUID,
  applied_at TIMESTAMP,
  UNIQUE (tenant_id, number)
);

CREATE TABLE inventory.count_lines (
  count_id UUID NOT NULL REFERENCES inventory.counts(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory.items(id) ON DELETE CASCADE,
  expected INT NOT NULL,
  counted INT CHECK (counted >= 0),
  difference INT,
  PRIMARY KEY (count_id, item_id)
);
CREATE INDEX idx_count_lines_tenant ON inventory.count_lines (tenant_id);

ALTER TABLE inventory.items
  ADD COLUMN category_id UUID REFERENCES inventory.categories(id) ON DELETE SET NULL,
  ADD COLUMN unit TEXT NOT NULL DEFAULT 'units' CHECK (btrim(unit) <> '' AND length(unit) <= 20),
  ADD COLUMN barcode TEXT CHECK (barcode IS NULL OR (btrim(barcode) <> '' AND length(barcode) <= 64)),
  ADD COLUMN vendor_id UUID REFERENCES accounting.vendors(id) ON DELETE SET NULL,
  ADD COLUMN reorder_to INT NOT NULL DEFAULT 0 CHECK (reorder_to >= 0);
CREATE UNIQUE INDEX items_barcode_key ON inventory.items (tenant_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_items_category ON inventory.items (category_id);
CREATE INDEX idx_items_vendor ON inventory.items (vendor_id);

ALTER TABLE inventory.movements
  ADD COLUMN location_id UUID REFERENCES inventory.locations(id) ON DELETE SET NULL,
  ADD COLUMN transfer_id UUID REFERENCES inventory.transfers(id) ON DELETE SET NULL,
  ADD COLUMN count_id UUID REFERENCES inventory.counts(id) ON DELETE SET NULL;
CREATE INDEX idx_movements_location ON inventory.movements (location_id);
CREATE INDEX idx_movements_transfer ON inventory.movements (transfer_id);
CREATE INDEX idx_movements_count ON inventory.movements (count_id);
CREATE INDEX idx_movements_tenant_created ON inventory.movements (tenant_id, created_at);

-- ---------------------------------------------------------------- access

ALTER TABLE inventory.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.count_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON inventory.locations FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON inventory.stock_levels FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON inventory.transfers FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON inventory.counts FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON inventory.count_lines FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON inventory.categories FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_writes ON inventory.categories FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'));

GRANT SELECT ON inventory.locations, inventory.stock_levels, inventory.transfers, inventory.counts, inventory.count_lines
  TO authenticated;
GRANT SELECT, DELETE ON inventory.categories TO authenticated;
GRANT INSERT (tenant_id, name) ON inventory.categories TO authenticated;
GRANT UPDATE (name) ON inventory.categories TO authenticated;
GRANT ALL ON inventory.locations, inventory.stock_levels, inventory.transfers, inventory.categories,
  inventory.counts, inventory.count_lines TO service_role;

-- Quantity and value still only change through the stock functions
GRANT INSERT (category_id, unit, barcode, vendor_id, reorder_to) ON inventory.items TO authenticated;
GRANT UPDATE (category_id, unit, barcode, vendor_id, reorder_to) ON inventory.items TO authenticated;

-- An item's category and supplier must belong to its company; blank barcodes and units are tidied
CREATE FUNCTION inventory.check_item()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  NEW.barcode := nullif(btrim(NEW.barcode), '');
  NEW.unit := coalesce(nullif(btrim(NEW.unit), ''), 'units');
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inventory.categories WHERE id = NEW.category_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Category not found';
  END IF;
  IF NEW.vendor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM accounting.vendors WHERE id = NEW.vendor_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Supplier not found';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_check_item BEFORE INSERT OR UPDATE OF category_id, vendor_id, barcode, unit ON inventory.items
  FOR EACH ROW EXECUTE FUNCTION inventory.check_item();
REVOKE EXECUTE ON FUNCTION inventory.check_item() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- the main warehouse

-- Every company has one main warehouse, made the first time it is needed
CREATE FUNCTION inventory.main_location(p_tenant UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found_id UUID;
BEGIN
  SELECT id INTO found_id FROM inventory.locations WHERE tenant_id = p_tenant AND is_main;
  IF found_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 4300));
    SELECT id INTO found_id FROM inventory.locations WHERE tenant_id = p_tenant AND is_main;
  END IF;
  IF found_id IS NULL THEN
    INSERT INTO inventory.locations (tenant_id, name, is_main)
      SELECT p_tenant, CASE WHEN EXISTS (
          SELECT 1 FROM inventory.locations WHERE tenant_id = p_tenant AND lower(name) = 'main warehouse'
        ) THEN 'Main warehouse ' || substr(gen_random_uuid()::text, 1, 4) ELSE 'Main warehouse' END, true
      RETURNING id INTO found_id;
  END IF;
  RETURN found_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.main_location(UUID) FROM PUBLIC, anon, authenticated;

-- Stock already on hand is in the main warehouse
SELECT inventory.main_location(t.tenant_id)
  FROM (SELECT DISTINCT tenant_id FROM inventory.items) t;
INSERT INTO inventory.stock_levels (tenant_id, item_id, location_id, quantity)
  SELECT i.tenant_id, i.id, l.id, i.quantity
  FROM inventory.items i JOIN inventory.locations l ON l.tenant_id = i.tenant_id AND l.is_main
  WHERE i.quantity > 0;
UPDATE inventory.movements m SET location_id = l.id
  FROM inventory.locations l
  WHERE l.tenant_id = m.tenant_id AND l.is_main AND m.change <> 0 AND m.location_id IS NULL;

-- ---------------------------------------------------------------- moving stock

-- The one place stock and its value change, now in a given place (blank means the main warehouse).
-- Same costing as before: a null cost means "at the average": stock in at the last average cost,
-- stock out at its share of the value on hand. If an item runs out with value left over, the rest
-- goes to Stock Adjustments, recorded as its own value-only movement so the movements always add up
-- to the stock value.
CREATE FUNCTION inventory.move_stock_at(
  p_tenant UUID, p_item UUID, p_location UUID, p_change INT, p_cost NUMERIC, p_reason TEXT,
  p_invoice UUID, p_bill UUID, p_count UUID
)
RETURNS inventory.movements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  stock inventory.items;
  moved inventory.movements;
  extra UUID;
  place inventory.locations;
  here INT;
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

  IF p_change <> 0 THEN
    SELECT * INTO place FROM inventory.locations
      WHERE id = coalesce(p_location, inventory.main_location(p_tenant)) AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Location not found';
    END IF;
    SELECT quantity INTO here FROM inventory.stock_levels WHERE item_id = stock.id AND location_id = place.id FOR UPDATE;
    IF coalesce(here, 0) + p_change < 0 THEN
      RAISE EXCEPTION 'Only % of % at %', coalesce(here, 0), stock.name, place.name;
    END IF;
    INSERT INTO inventory.stock_levels AS s (tenant_id, item_id, location_id, quantity)
      VALUES (p_tenant, stock.id, place.id, p_change)
      ON CONFLICT (item_id, location_id) DO UPDATE SET quantity = s.quantity + EXCLUDED.quantity;
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

  INSERT INTO inventory.movements (tenant_id, item_id, change, cost, reason, invoice_id, bill_id, location_id, count_id)
    VALUES (p_tenant, stock.id, p_change, value, p_reason, p_invoice, p_bill, place.id, p_count)
    RETURNING * INTO moved;

  IF left_over <> 0 THEN
    INSERT INTO inventory.movements (tenant_id, item_id, change, cost, reason)
      VALUES (p_tenant, stock.id, 0, -left_over, 'Value left when it ran out')
      RETURNING id INTO extra;
    PERFORM accounting.insert_entry(p_tenant, current_date, 'Stock value left when ' || stock.name || ' ran out',
      'stock_adjustment', extra, NULL, accounting.transfer_lines(p_tenant, '5100', '1400', left_over));
  END IF;
  RETURN moved;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.move_stock_at(UUID, UUID, UUID, INT, NUMERIC, TEXT, UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;

-- Takes stock out from wherever it is: the preferred place first, then the main warehouse, then the
-- rest by name. A given cost (signed, negative for value going out) is shared across the places.
-- Returns the last movement, with change and cost set to the totals.
CREATE FUNCTION inventory.take_stock(
  p_tenant UUID, p_item UUID, p_quantity INT, p_cost NUMERIC, p_reason TEXT,
  p_invoice UUID, p_bill UUID, p_prefer UUID, p_count UUID
)
RETURNS inventory.movements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  stock inventory.items;
  spot RECORD;
  moved inventory.movements;
  piece INT;
  remaining INT := p_quantity;
  cost_left NUMERIC := p_cost;
  total NUMERIC := 0;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be more than zero';
  END IF;
  SELECT * INTO stock FROM inventory.items WHERE id = p_item AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found';
  END IF;
  IF stock.quantity < p_quantity THEN
    RAISE EXCEPTION 'Only % of % in stock', stock.quantity, stock.name;
  END IF;

  FOR spot IN
    SELECT s.location_id, s.quantity
    FROM inventory.stock_levels s JOIN inventory.locations l ON l.id = s.location_id
    WHERE s.item_id = stock.id AND s.quantity > 0
    ORDER BY coalesce(s.location_id = p_prefer, false) DESC, l.is_main DESC, l.name
  LOOP
    EXIT WHEN remaining = 0;
    piece := least(remaining, spot.quantity);
    moved := inventory.move_stock_at(p_tenant, stock.id, spot.location_id, -piece,
      CASE WHEN p_cost IS NULL THEN NULL WHEN piece = remaining THEN cost_left
        ELSE round(p_cost * piece / p_quantity, 2) END,
      p_reason, p_invoice, p_bill, p_count);
    remaining := remaining - piece;
    total := total + moved.cost;
    cost_left := cost_left - moved.cost;
  END LOOP;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'Only % of % in stock', p_quantity - remaining, stock.name;
  END IF;
  moved.change := -p_quantity;
  moved.cost := total;
  RETURN moved;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.take_stock(UUID, UUID, INT, NUMERIC, TEXT, UUID, UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;

-- Kept for anything still calling it: stock in goes to the main warehouse, stock out comes from
-- wherever it is, main warehouse first. The result's change and cost are the totals.
CREATE OR REPLACE FUNCTION inventory.move_stock(
  p_tenant UUID, p_item UUID, p_change INT, p_cost NUMERIC, p_reason TEXT, p_invoice UUID, p_bill UUID
)
RETURNS inventory.movements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_change < 0 THEN
    RETURN inventory.take_stock(p_tenant, p_item, -p_change, p_cost, p_reason, p_invoice, p_bill, NULL, NULL);
  END IF;
  RETURN inventory.move_stock_at(p_tenant, p_item, NULL, p_change, p_cost, p_reason, p_invoice, p_bill, NULL);
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.move_stock(UUID, UUID, INT, NUMERIC, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Counts, damage and opening stock, now optionally in a given place. Same behaviour as before
-- when no place is given.
DROP FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT, NUMERIC, BOOLEAN);
CREATE FUNCTION inventory.adjust_stock(
  p_tenant UUID, p_item UUID, p_change INT, p_reason TEXT, p_unit_cost NUMERIC DEFAULT NULL,
  p_opening BOOLEAN DEFAULT false, p_location UUID DEFAULT NULL
)
RETURNS inventory.items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  moved inventory.movements;
  updated inventory.items;
  place inventory.locations;
  cost NUMERIC;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_change IS NULL OR p_change = 0 THEN
    RAISE EXCEPTION 'Change must be a whole number, positive or negative';
  END IF;
  IF p_unit_cost IS NOT NULL AND (p_unit_cost < 0 OR p_unit_cost >= 1e10) THEN
    RAISE EXCEPTION 'Enter a valid unit cost';
  END IF;
  cost := CASE WHEN p_change > 0 AND p_unit_cost IS NOT NULL THEN p_change * p_unit_cost END;

  IF p_location IS NOT NULL THEN
    SELECT * INTO place FROM inventory.locations WHERE id = p_location AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Location not found';
    END IF;
    IF p_change > 0 AND NOT place.active THEN
      RAISE EXCEPTION '% is archived', place.name;
    END IF;
    moved := inventory.move_stock_at(p_tenant, p_item, place.id, p_change, cost, nullif(btrim(p_reason), ''), NULL, NULL, NULL);
  ELSE
    moved := inventory.move_stock(p_tenant, p_item, p_change, cost, nullif(btrim(p_reason), ''), NULL, NULL);
  END IF;

  IF moved.cost <> 0 THEN
    PERFORM accounting.insert_entry(p_tenant, current_date,
      CASE WHEN p_opening THEN 'Opening stock' ELSE 'Stock adjustment' || coalesce(': ' || moved.reason, '') END
        || ' (' || (SELECT name FROM inventory.items WHERE id = p_item) || ')',
      'stock_adjustment', moved.id, NULL,
      accounting.transfer_lines(p_tenant, '1400', CASE WHEN p_opening THEN '3000' ELSE '5100' END, moved.cost));
  END IF;

  SELECT * INTO updated FROM inventory.items WHERE id = p_item;
  RETURN updated;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT, NUMERIC, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT, NUMERIC, BOOLEAN, UUID) TO authenticated;

-- ---------------------------------------------------------------- invoices and bills

-- Invoices: stock out at the average, from the place a line names or else wherever it is (main
-- warehouse first); back in at the cost it left at, to the places it came from. Cost of goods
-- sold is kept in step with whatever the invoice has taken.
CREATE OR REPLACE FUNCTION accounting.sync_invoice_stock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  move RECORD;
  spot RECORD;
  piece INT;
  giving_back INT;
  reason TEXT;
  cost_of_sales NUMERIC;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.line_items = OLD.line_items
     AND NEW.invoice_date IS NOT DISTINCT FROM OLD.invoice_date AND NEW.cost_center_id IS NOT DISTINCT FROM OLD.cost_center_id THEN
    RETURN NULL;
  END IF;
  reason := 'Invoice ' || NEW.invoice_number;

  FOR move IN
    WITH lines AS (
      SELECT (l->>'item_id')::uuid AS item_id, (l->>'quantity')::numeric AS quantity,
        nullif(l->>'location_id', '') AS place, n
      FROM jsonb_array_elements(CASE WHEN NEW.status IN ('sent', 'partial', 'paid') THEN NEW.line_items ELSE '[]'::jsonb END)
        WITH ORDINALITY x(l, n)
      WHERE coalesce(l->>'item_id', '') <> ''
    ), wanted AS (
      SELECT item_id, sum(quantity) AS quantity,
        (array_agg(place ORDER BY n) FILTER (WHERE place IS NOT NULL))[1] AS place
      FROM lines GROUP BY 1
    ), taken AS (
      SELECT m.item_id, -sum(m.change) AS quantity
      FROM inventory.movements m WHERE m.invoice_id = NEW.id
      GROUP BY 1
    )
    SELECT coalesce(w.item_id, t.item_id) AS item_id, coalesce(w.quantity, 0) - coalesce(t.quantity, 0) AS more, w.place
    FROM wanted w FULL JOIN taken t ON t.item_id = w.item_id
  LOOP
    CONTINUE WHEN move.more = 0;
    IF move.more <> trunc(move.more) THEN
      RAISE EXCEPTION 'Stock items need whole quantities';
    END IF;

    IF move.more > 0 THEN
      IF move.place IS NOT NULL THEN
        IF move.place !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'Location not found';
        END IF;
        PERFORM inventory.move_stock_at(NEW.tenant_id, move.item_id, move.place::uuid, -move.more::int, NULL,
          reason, NEW.id, NULL, NULL);
      ELSE
        PERFORM inventory.take_stock(NEW.tenant_id, move.item_id, move.more::int, NULL, reason, NEW.id, NULL, NULL, NULL);
      END IF;
    ELSE
      giving_back := -move.more::int;
      FOR spot IN
        SELECT m.location_id, -sum(m.change)::int AS quantity, -sum(m.cost) AS cost
        FROM inventory.movements m WHERE m.invoice_id = NEW.id AND m.item_id = move.item_id
        GROUP BY m.location_id HAVING -sum(m.change) > 0
        ORDER BY m.location_id
      LOOP
        EXIT WHEN giving_back = 0;
        piece := least(giving_back, spot.quantity);
        PERFORM inventory.move_stock_at(NEW.tenant_id, move.item_id, spot.location_id, piece,
          CASE WHEN piece = spot.quantity THEN spot.cost ELSE round(spot.cost * piece / spot.quantity, 2) END,
          reason, NEW.id, NULL, NULL);
        giving_back := giving_back - piece;
      END LOOP;
    END IF;
  END LOOP;

  SELECT -coalesce(sum(cost), 0) INTO cost_of_sales FROM inventory.movements WHERE invoice_id = NEW.id;
  PERFORM accounting.sync_entry(NEW.tenant_id, 'invoice_cost', NEW.id, NEW.invoice_date,
    'Cost of sales, invoice ' || NEW.invoice_number,
    accounting.transfer_lines(NEW.tenant_id, '5000', '1400', cost_of_sales, NEW.cost_center_id));
  RETURN NULL;
END;
$$;

-- Bills: brings in what a posted bill bought, at the bill's cost in the base currency, into the
-- place a line names or else the main warehouse; takes it back out at that same cost if the bill
-- is voided or changed, from where it went in first.
CREATE OR REPLACE FUNCTION accounting.sync_bill_stock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  move RECORD;
  reason TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.line_items = OLD.line_items
     AND NEW.exchange_rate = OLD.exchange_rate THEN
    RETURN NULL;
  END IF;
  reason := 'Bill ' || NEW.bill_number;

  FOR move IN
    WITH lines AS (
      SELECT (l->>'item_id')::uuid AS item_id, (l->>'quantity')::int AS quantity, round((l->>'amount')::numeric, 2) AS amount,
        nullif(l->>'cost_center_id', '') AS cost_center, nullif(l->>'location_id', '') AS place, n
      FROM jsonb_array_elements(CASE WHEN NEW.status IN ('open', 'partial', 'paid') THEN NEW.line_items ELSE '[]'::jsonb END)
        WITH ORDINALITY x(l, n)
      WHERE coalesce(l->>'item_id', '') <> ''
    ), wanted AS (
      SELECT item_id, sum(quantity) AS quantity, round(sum(amount) * NEW.exchange_rate, 2) AS cost
      FROM lines GROUP BY 1, cost_center
    ), wanted_items AS (
      SELECT item_id, sum(quantity) AS quantity, sum(cost) AS cost FROM wanted GROUP BY 1
    ), places AS (
      SELECT item_id, (array_agg(place ORDER BY n) FILTER (WHERE place IS NOT NULL))[1] AS place FROM lines GROUP BY 1
    ), received AS (
      SELECT m.item_id, sum(m.change) AS quantity, sum(m.cost) AS cost
      FROM inventory.movements m WHERE m.bill_id = NEW.id
      GROUP BY 1
    )
    SELECT coalesce(w.item_id, r.item_id) AS item_id,
      coalesce(w.quantity, 0) - coalesce(r.quantity, 0) AS more,
      coalesce(w.cost, 0) - coalesce(r.cost, 0) AS more_cost,
      p.place
    FROM wanted_items w FULL JOIN received r ON r.item_id = w.item_id
    LEFT JOIN places p ON p.item_id = coalesce(w.item_id, r.item_id)
  LOOP
    CONTINUE WHEN move.more = 0 AND move.more_cost = 0;
    IF move.place IS NOT NULL AND move.place !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Location not found';
    END IF;

    IF move.more < 0 THEN
      PERFORM inventory.take_stock(NEW.tenant_id, move.item_id, -move.more::int, move.more_cost, reason, NULL, NEW.id,
        coalesce(move.place::uuid, (
          SELECT m.location_id FROM inventory.movements m
          WHERE m.bill_id = NEW.id AND m.item_id = move.item_id AND m.change > 0
          ORDER BY m.created_at LIMIT 1
        )), NULL);
    ELSE
      PERFORM inventory.move_stock_at(NEW.tenant_id, move.item_id, CASE WHEN move.more > 0 THEN move.place::uuid END,
        move.more::int, move.more_cost, reason, NULL, NEW.id, NULL);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- A bill made from a purchase order keeps the order's stock items, so it brings the stock in.
-- Runs before prepare_bill, which then checks and posts the lines as usual.
CREATE FUNCTION inventory.bill_lines_from_order()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  order_lines JSONB;
BEGIN
  IF NEW.po_id IS NULL OR jsonb_typeof(NEW.line_items) IS DISTINCT FROM 'array' THEN
    RETURN NEW;
  END IF;
  SELECT line_items INTO order_lines FROM accounting.purchase_orders WHERE id = NEW.po_id AND tenant_id = NEW.tenant_id;
  IF jsonb_typeof(order_lines) IS DISTINCT FROM 'array' OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(order_lines) o WHERE coalesce(o->>'item_id', '') <> ''
  ) THEN
    RETURN NEW;
  END IF;

  SELECT jsonb_agg(CASE WHEN coalesce(b->>'item_id', '') = '' AND o.line IS NOT NULL
      THEN b || jsonb_build_object('item_id', o.line->>'item_id',
        'quantity', CASE WHEN (o.line->>'quantity')::numeric = trunc((o.line->>'quantity')::numeric)
          THEN to_jsonb(trunc((o.line->>'quantity')::numeric)::bigint) ELSE o.line->'quantity' END)
        || CASE WHEN coalesce(o.line->>'location_id', '') <> '' THEN jsonb_build_object('location_id', o.line->>'location_id')
          ELSE '{}'::jsonb END
      ELSE b END ORDER BY n)
    INTO NEW.line_items
    FROM jsonb_array_elements(NEW.line_items) WITH ORDINALITY x(b, n)
    LEFT JOIN LATERAL (
      SELECT ol AS line FROM jsonb_array_elements(order_lines) WITH ORDINALITY y(ol, k)
      WHERE coalesce(ol->>'item_id', '') <> ''
        AND ol->>'account_id' = b->>'account_id'
        AND coalesce(ol->>'description', '') = coalesce(b->>'description', '')
        AND round((ol->>'quantity')::numeric * (ol->>'unit_price')::numeric, 2) = round((b->>'amount')::numeric, 2)
      ORDER BY (k = n) DESC, k
      LIMIT 1
    ) o ON true;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b_stock_lines_from_order BEFORE INSERT ON accounting.bills
  FOR EACH ROW EXECUTE FUNCTION inventory.bill_lines_from_order();
REVOKE EXECUTE ON FUNCTION inventory.bill_lines_from_order() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- warehouses

CREATE FUNCTION inventory.list_locations(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  PERFORM inventory.main_location(p_tenant);
  RETURN (
    SELECT coalesce(json_agg(r ORDER BY r.is_main DESC, r.active DESC, r.name), '[]'::json) FROM (
      SELECT l.id, l.name, l.is_main, l.active, l.created_at,
        count(s.item_id) FILTER (WHERE s.quantity > 0) AS items,
        coalesce(sum(s.quantity), 0) AS quantity,
        coalesce(round(sum(CASE WHEN i.quantity > 0 THEN i.stock_value * s.quantity / i.quantity ELSE 0 END), 2), 0) AS value
      FROM inventory.locations l
      LEFT JOIN inventory.stock_levels s ON s.location_id = l.id
      LEFT JOIN inventory.items i ON i.id = s.item_id
      WHERE l.tenant_id = p_tenant
      GROUP BY l.id
    ) r
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.list_locations(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.list_locations(UUID) TO authenticated;

-- Add or rename a place, make it the main warehouse, or archive an empty one. Owners and admins only.
CREATE FUNCTION inventory.save_location(p_tenant UUID, p_location UUID, p_name TEXT, p_active BOOLEAN, p_main BOOLEAN)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  place inventory.locations;
  clean TEXT := btrim(p_name);
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  PERFORM inventory.main_location(p_tenant);
  IF clean IS NULL OR clean = '' THEN
    RAISE EXCEPTION 'Enter a name';
  END IF;
  IF length(clean) > 80 THEN
    RAISE EXCEPTION 'Keep the name under 80 characters';
  END IF;

  IF p_location IS NULL THEN
    INSERT INTO inventory.locations (tenant_id, name) VALUES (p_tenant, clean) RETURNING * INTO place;
  ELSE
    UPDATE inventory.locations SET name = clean WHERE id = p_location AND tenant_id = p_tenant RETURNING * INTO place;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Location not found';
    END IF;
  END IF;

  IF coalesce(p_active, true) = false AND place.active THEN
    IF place.is_main OR coalesce(p_main, false) THEN
      RAISE EXCEPTION 'Make another place the main warehouse before archiving %', place.name;
    END IF;
    IF EXISTS (SELECT 1 FROM inventory.stock_levels WHERE location_id = place.id AND quantity > 0) THEN
      RAISE EXCEPTION 'Move the stock out of % before archiving it', place.name;
    END IF;
    UPDATE inventory.locations SET active = false WHERE id = place.id;
  ELSIF coalesce(p_active, true) AND NOT place.active THEN
    UPDATE inventory.locations SET active = true WHERE id = place.id;
  END IF;

  IF coalesce(p_main, false) AND NOT place.is_main THEN
    IF coalesce(p_active, true) = false THEN
      RAISE EXCEPTION 'The main warehouse cannot be archived';
    END IF;
    UPDATE inventory.locations SET is_main = false WHERE tenant_id = p_tenant AND is_main;
    UPDATE inventory.locations SET is_main = true, active = true WHERE id = place.id;
  END IF;
  RETURN place.id;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.save_location(UUID, UUID, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.save_location(UUID, UUID, TEXT, BOOLEAN, BOOLEAN) TO authenticated;

-- Moves stock between two places. Quantity moves; value and the books do not.
CREATE FUNCTION inventory.transfer_stock(p_tenant UUID, p_from UUID, p_to UUID, p_lines JSONB, p_note TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  source inventory.locations;
  target inventory.locations;
  line RECORD;
  here INT;
  wanted INT;
  found INT;
  next_number INT;
  moved_id UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO source FROM inventory.locations WHERE id = p_from AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose where the stock is moving from';
  END IF;
  SELECT * INTO target FROM inventory.locations WHERE id = p_to AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose where the stock is going';
  END IF;
  IF source.id = target.id THEN
    RAISE EXCEPTION 'Choose two different places';
  END IF;
  IF NOT target.active THEN
    RAISE EXCEPTION '% is archived', target.name;
  END IF;
  IF length(p_note) > 500 THEN
    RAISE EXCEPTION 'Keep the note under 500 characters';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one item';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    WHERE coalesce(l->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR coalesce(l->>'quantity', '') !~ '^\d{1,9}$' OR (l->>'quantity')::int <= 0
  ) THEN
    RAISE EXCEPTION 'Each line needs an item and a whole quantity above zero';
  END IF;

  -- Items are locked in a fixed order, the same way stock changes lock them
  SELECT count(DISTINCT l->>'item_id') INTO wanted FROM jsonb_array_elements(p_lines) l;
  SELECT count(*) INTO found FROM (
    SELECT id FROM inventory.items
    WHERE tenant_id = p_tenant AND id IN (SELECT (l->>'item_id')::uuid FROM jsonb_array_elements(p_lines) l)
    ORDER BY id FOR UPDATE
  ) locked;
  IF found <> wanted THEN
    RAISE EXCEPTION 'Item not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 4301));
  SELECT coalesce(max(number), 0) + 1 INTO next_number FROM inventory.transfers WHERE tenant_id = p_tenant;
  INSERT INTO inventory.transfers (tenant_id, number, from_location, to_location, note, created_by)
    VALUES (p_tenant, next_number, source.id, target.id, nullif(btrim(p_note), ''), auth.uid())
    RETURNING id INTO moved_id;

  FOR line IN
    SELECT i.id, i.name, sum((l->>'quantity')::int)::int AS quantity
    FROM jsonb_array_elements(p_lines) l JOIN inventory.items i ON i.id = (l->>'item_id')::uuid
    GROUP BY i.id ORDER BY i.id
  LOOP
    SELECT quantity INTO here FROM inventory.stock_levels WHERE item_id = line.id AND location_id = source.id FOR UPDATE;
    IF coalesce(here, 0) < line.quantity THEN
      RAISE EXCEPTION 'Only % of % at %', coalesce(here, 0), line.name, source.name;
    END IF;
    UPDATE inventory.stock_levels SET quantity = quantity - line.quantity WHERE item_id = line.id AND location_id = source.id;
    INSERT INTO inventory.stock_levels AS s (tenant_id, item_id, location_id, quantity)
      VALUES (p_tenant, line.id, target.id, line.quantity)
      ON CONFLICT (item_id, location_id) DO UPDATE SET quantity = s.quantity + EXCLUDED.quantity;
    INSERT INTO inventory.movements (tenant_id, item_id, change, cost, reason, location_id, transfer_id) VALUES
      (p_tenant, line.id, -line.quantity, 0, 'Transfer ' || next_number || ': moved to ' || target.name, source.id, moved_id),
      (p_tenant, line.id, line.quantity, 0, 'Transfer ' || next_number || ': moved from ' || source.name, target.id, moved_id);
  END LOOP;

  RETURN json_build_object('id', moved_id, 'number', next_number, 'items', wanted);
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.transfer_stock(UUID, UUID, UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.transfer_stock(UUID, UUID, UUID, JSONB, TEXT) TO authenticated;

-- ---------------------------------------------------------------- stock counts

-- Starts a count sheet for one place, listing every item (or one category) with what the
-- system thinks is there
CREATE FUNCTION inventory.start_count(p_tenant UUID, p_location UUID, p_category UUID, p_note TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  place inventory.locations;
  next_number INT;
  sheet UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO place FROM inventory.locations WHERE id = p_location AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose where you are counting';
  END IF;
  IF NOT place.active THEN
    RAISE EXCEPTION '% is archived', place.name;
  END IF;
  IF p_category IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventory.categories WHERE id = p_category AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Category not found';
  END IF;
  IF length(p_note) > 500 THEN
    RAISE EXCEPTION 'Keep the note under 500 characters';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM inventory.items WHERE tenant_id = p_tenant AND (p_category IS NULL OR category_id = p_category)
  ) THEN
    RAISE EXCEPTION 'There are no items to count';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 4302));
  SELECT coalesce(max(number), 0) + 1 INTO next_number FROM inventory.counts WHERE tenant_id = p_tenant;
  INSERT INTO inventory.counts (tenant_id, number, location_id, category_id, note, created_by)
    VALUES (p_tenant, next_number, place.id, p_category, nullif(btrim(p_note), ''), auth.uid())
    RETURNING id INTO sheet;
  INSERT INTO inventory.count_lines (count_id, tenant_id, item_id, expected)
    SELECT sheet, p_tenant, i.id, coalesce(s.quantity, 0)
    FROM inventory.items i
    LEFT JOIN inventory.stock_levels s ON s.item_id = i.id AND s.location_id = place.id
    WHERE i.tenant_id = p_tenant AND (p_category IS NULL OR i.category_id = p_category);
  RETURN sheet;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.start_count(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.start_count(UUID, UUID, UUID, TEXT) TO authenticated;

-- Saves counted quantities on an open sheet. A blank count means "not counted": it is left alone.
-- Items missing from the sheet are added to it.
CREATE FUNCTION inventory.save_count(p_tenant UUID, p_count UUID, p_lines JSONB)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  sheet inventory.counts;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO sheet FROM inventory.counts WHERE id = p_count AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;
  IF sheet.status <> 'open' THEN
    RAISE EXCEPTION 'This count is already %', sheet.status;
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nothing to save';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    WHERE coalesce(l->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (l->>'counted' IS NOT NULL AND l->>'counted' !~ '^\d{1,9}$')
  ) THEN
    RAISE EXCEPTION 'Counts must be whole numbers, zero or more';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN inventory.items i ON i.id = (l->>'item_id')::uuid AND i.tenant_id = p_tenant
    WHERE i.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Item not found';
  END IF;

  INSERT INTO inventory.count_lines (count_id, tenant_id, item_id, expected, counted)
    SELECT DISTINCT ON ((l->>'item_id')::uuid) sheet.id, p_tenant, (l->>'item_id')::uuid, coalesce(s.quantity, 0),
      (l->>'counted')::int
    FROM jsonb_array_elements(p_lines) l
    LEFT JOIN inventory.stock_levels s ON s.item_id = (l->>'item_id')::uuid AND s.location_id = sheet.location_id
    ON CONFLICT (count_id, item_id) DO UPDATE SET counted = EXCLUDED.counted;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.save_count(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.save_count(UUID, UUID, JSONB) TO authenticated;

-- Applies a count: each counted item is set to what was counted, against what is there now,
-- at the average cost. The net change in value is one entry against Stock Adjustments.
CREATE FUNCTION inventory.apply_count(p_tenant UUID, p_count UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  sheet inventory.counts;
  place inventory.locations;
  line RECORD;
  here INT;
  moved inventory.movements;
  total NUMERIC := 0;
  changed INT := 0;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO sheet FROM inventory.counts WHERE id = p_count AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;
  IF sheet.status <> 'open' THEN
    RAISE EXCEPTION 'This count is already %', sheet.status;
  END IF;
  SELECT * INTO place FROM inventory.locations WHERE id = sheet.location_id;
  IF NOT EXISTS (SELECT 1 FROM inventory.count_lines WHERE count_id = sheet.id AND counted IS NOT NULL) THEN
    RAISE EXCEPTION 'Enter at least one count first';
  END IF;

  FOR line IN
    SELECT c.item_id, c.counted FROM inventory.count_lines c
    WHERE c.count_id = sheet.id AND c.counted IS NOT NULL ORDER BY c.item_id
  LOOP
    PERFORM 1 FROM inventory.items WHERE id = line.item_id FOR UPDATE;
    SELECT quantity INTO here FROM inventory.stock_levels WHERE item_id = line.item_id AND location_id = place.id;
    here := coalesce(here, 0);
    UPDATE inventory.count_lines SET difference = line.counted - here WHERE count_id = sheet.id AND item_id = line.item_id;
    IF line.counted <> here THEN
      IF line.counted > here AND NOT place.active THEN
        RAISE EXCEPTION '% is archived', place.name;
      END IF;
      moved := inventory.move_stock_at(p_tenant, line.item_id, place.id, line.counted - here, NULL,
        'Stock count ' || sheet.number || ' at ' || place.name, NULL, NULL, sheet.id);
      total := total + moved.cost;
      changed := changed + 1;
    END IF;
  END LOOP;

  IF total <> 0 THEN
    PERFORM accounting.insert_entry(p_tenant, current_date, 'Stock count ' || sheet.number || ' at ' || place.name,
      'stock_adjustment', sheet.id, NULL, accounting.transfer_lines(p_tenant, '1400', '5100', total));
  END IF;
  UPDATE inventory.counts SET status = 'applied', applied_by = auth.uid(), applied_at = now(), value_change = total
    WHERE id = sheet.id;
  RETURN json_build_object('adjusted', changed, 'value_change', total);
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.apply_count(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.apply_count(UUID, UUID) TO authenticated;

CREATE FUNCTION inventory.cancel_count(p_tenant UUID, p_count UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE inventory.counts SET status = 'cancelled' WHERE id = p_count AND tenant_id = p_tenant AND status = 'open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only open counts can be cancelled';
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.cancel_count(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.cancel_count(UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------- reports

-- Quantity and value of each item at the end of a day, from its movements, and the Inventory
-- account balance on that day. They can differ when invoices or bills are dated in the past,
-- because stock moves when they are posted. For one place, value is its share of the item's value.
CREATE FUNCTION inventory.stock_valuation(p_tenant UUID, p_date DATE, p_location UUID DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Choose a date';
  END IF;

  RETURN (
    WITH moves AS (
      SELECT item_id, location_id, change, cost FROM inventory.movements
      WHERE tenant_id = p_tenant AND created_at < (p_date + 1)
    ), per_item AS (
      SELECT item_id, sum(change) AS quantity, sum(cost) AS value FROM moves GROUP BY 1
    ), per_place AS (
      SELECT item_id, sum(change) AS quantity FROM moves WHERE location_id = p_location GROUP BY 1
    ), rows AS (
      SELECT i.id AS item_id, i.sku, i.name, i.unit, c.name AS category,
        CASE WHEN p_location IS NULL THEN p.quantity ELSE coalesce(pp.quantity, 0) END AS quantity,
        CASE WHEN p_location IS NULL THEN p.value
          WHEN p.quantity > 0 THEN round(p.value * coalesce(pp.quantity, 0) / p.quantity, 2) ELSE 0 END AS value
      FROM per_item p
      JOIN inventory.items i ON i.id = p.item_id AND i.tenant_id = p_tenant
      LEFT JOIN per_place pp ON pp.item_id = p.item_id
      LEFT JOIN inventory.categories c ON c.id = i.category_id
    ), shown AS (
      SELECT *, CASE WHEN quantity > 0 THEN round(value / quantity, 4) END AS unit_cost
      FROM rows WHERE quantity <> 0 OR value <> 0
    )
    SELECT json_build_object(
      'date', p_date,
      'location_id', p_location,
      'items', coalesce((SELECT json_agg(s ORDER BY s.name) FROM shown s), '[]'::json),
      'quantity', coalesce((SELECT sum(quantity) FROM shown), 0),
      'value', coalesce((SELECT sum(value) FROM shown), 0),
      'ledger', CASE WHEN p_location IS NULL THEN (
        SELECT coalesce(sum(l.debit - l.credit), 0)
        FROM accounting.journal_lines l
        JOIN accounting.journal_entries e ON e.id = l.entry_id
        JOIN accounting.accounts a ON a.id = l.account_id
        WHERE l.tenant_id = p_tenant AND a.tenant_id = p_tenant AND a.code = '1400' AND e.entry_date <= p_date
      ) END
    )
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.stock_valuation(UUID, DATE, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.stock_valuation(UUID, DATE, UUID) TO authenticated;

-- Items at or below their reorder level, counting what is already on order (purchase orders not
-- yet billed, and draft bills). Suggests enough to reach "order up to", or the reorder level.
CREATE FUNCTION inventory.reorder_suggestions(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH ordered AS (
    SELECT (l->>'item_id')::uuid AS item_id, (l->>'quantity')::numeric AS quantity
    FROM accounting.purchase_orders p, jsonb_array_elements(p.line_items) l
    WHERE p.tenant_id = p_tenant AND p.status IN ('draft', 'pending', 'approved')
      AND coalesce(l->>'item_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND coalesce(l->>'quantity', '') ~ '^\d+(\.\d+)?$'
    UNION ALL
    SELECT (l->>'item_id')::uuid, (l->>'quantity')::numeric
    FROM accounting.bills b, jsonb_array_elements(b.line_items) l
    WHERE b.tenant_id = p_tenant AND b.status = 'draft'
      AND coalesce(l->>'item_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND coalesce(l->>'quantity', '') ~ '^\d+(\.\d+)?$'
  ), on_order AS (
    SELECT item_id, sum(quantity) AS quantity FROM ordered GROUP BY 1
  ), last_cost AS (
    SELECT DISTINCT ON (item_id) item_id, round(cost / change, 4) AS unit_cost
    FROM inventory.movements
    WHERE tenant_id = p_tenant AND bill_id IS NOT NULL AND change > 0
    ORDER BY item_id, created_at DESC
  ), rows AS (
    SELECT i.id AS item_id, i.sku, i.name, i.unit, i.quantity AS on_hand, coalesce(o.quantity, 0) AS on_order,
      i.reorder_level, i.reorder_to, greatest(i.reorder_to, i.reorder_level) AS target,
      i.vendor_id, v.name AS vendor_name, coalesce(lc.unit_cost, i.avg_cost) AS unit_cost
    FROM inventory.items i
    LEFT JOIN on_order o ON o.item_id = i.id
    LEFT JOIN last_cost lc ON lc.item_id = i.id
    LEFT JOIN accounting.vendors v ON v.id = i.vendor_id
    WHERE i.tenant_id = p_tenant
  )
  SELECT coalesce(json_agg(json_build_object(
      'item_id', item_id, 'sku', sku, 'name', name, 'unit', unit, 'on_hand', on_hand, 'on_order', on_order,
      'reorder_level', reorder_level, 'reorder_to', reorder_to, 'vendor_id', vendor_id, 'vendor_name', vendor_name,
      'unit_cost', unit_cost, 'suggested', ceil(target - on_hand - on_order)::int
    ) ORDER BY vendor_name NULLS LAST, name), '[]'::json)
  FROM rows
  WHERE on_hand + on_order <= reorder_level AND target > on_hand + on_order;
$$;
REVOKE EXECUTE ON FUNCTION inventory.reorder_suggestions(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.reorder_suggestions(UUID) TO authenticated;

-- Turns chosen suggestions into draft purchase orders, one per supplier, through the normal
-- purchase order function. Lines go to the Inventory account and carry the stock item, so the
-- bill made from the order brings the stock in.
CREATE FUNCTION inventory.create_reorder_orders(p_tenant UUID, p_lines JSONB, p_expected DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  stock_account UUID;
  supplier RECORD;
  order_id UUID;
  made JSONB := '[]'::jsonb;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Choose at least one item to order';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'Order up to 500 items at a time';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    WHERE coalesce(l->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR coalesce(l->>'quantity', '') !~ '^\d{1,9}$' OR (l->>'quantity')::int <= 0
  ) THEN
    RAISE EXCEPTION 'Each line needs an item and a whole quantity above zero';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    WHERE coalesce(l->>'unit_price', '') !~ '^\d{1,10}(\.\d{1,4})?$'
  ) THEN
    RAISE EXCEPTION 'Each line needs a price of zero or more';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    WHERE coalesce(l->>'vendor_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'Choose a supplier for every item';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN inventory.items i ON i.id = (l->>'item_id')::uuid AND i.tenant_id = p_tenant
    WHERE i.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Item not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.vendors v ON v.id = (l->>'vendor_id')::uuid AND v.tenant_id = p_tenant
    WHERE v.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Supplier not found';
  END IF;

  stock_account := accounting.account_by_code(p_tenant, '1400');
  IF stock_account IS NULL THEN
    RAISE EXCEPTION 'The Inventory account is missing';
  END IF;

  FOR supplier IN
    SELECT (l->>'vendor_id')::uuid AS vendor_id, v.name,
      jsonb_agg(jsonb_build_object(
        'description', i.name || ' (' || i.sku || ')',
        'account_id', stock_account,
        'quantity', (l->>'quantity')::int,
        'unit_price', (l->>'unit_price')::numeric,
        'item_id', i.id
      ) ORDER BY i.name) AS lines
    FROM jsonb_array_elements(p_lines) l
    JOIN inventory.items i ON i.id = (l->>'item_id')::uuid
    JOIN accounting.vendors v ON v.id = (l->>'vendor_id')::uuid
    GROUP BY 1, 2 ORDER BY 2
  LOOP
    order_id := accounting.save_purchase_order(p_tenant, NULL, supplier.vendor_id, current_date, p_expected,
      NULL, NULL, supplier.lines, 'From reorder suggestions');
    made := made || jsonb_build_object('id', order_id, 'vendor', supplier.name,
      'po_number', (SELECT po_number FROM accounting.purchase_orders WHERE id = order_id));
  END LOOP;
  RETURN made::json;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.create_reorder_orders(UUID, JSONB, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory.create_reorder_orders(UUID, JSONB, DATE) TO authenticated;
