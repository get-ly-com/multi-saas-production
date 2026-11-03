-- A variable named "found" hid PL/pgSQL's FOUND, so transfers failed. Same function, renamed variable.
CREATE OR REPLACE FUNCTION inventory.transfer_stock(p_tenant UUID, p_from UUID, p_to UUID, p_lines JSONB, p_note TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  source inventory.locations;
  target inventory.locations;
  line RECORD;
  here INT;
  wanted INT;
  found_count INT;
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
  SELECT count(*) INTO found_count FROM (
    SELECT id FROM inventory.items
    WHERE tenant_id = p_tenant AND id IN (SELECT (l->>'item_id')::uuid FROM jsonb_array_elements(p_lines) l)
    ORDER BY id FOR UPDATE
  ) locked;
  IF found_count <> wanted THEN
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
