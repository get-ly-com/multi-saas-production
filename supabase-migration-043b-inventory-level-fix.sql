-- Taking stock out of a place tripped the "no negative stock" check before the existing row
-- was updated. The level row is now updated when it exists and only inserted when it does not.
CREATE OR REPLACE FUNCTION inventory.move_stock_at(
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
    -- The item row is locked, so nobody else can add this level row in the meantime
    IF here IS NULL THEN
      INSERT INTO inventory.stock_levels (tenant_id, item_id, location_id, quantity)
        VALUES (p_tenant, stock.id, place.id, p_change);
    ELSE
      UPDATE inventory.stock_levels SET quantity = quantity + p_change
        WHERE item_id = stock.id AND location_id = place.id;
    END IF;
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
