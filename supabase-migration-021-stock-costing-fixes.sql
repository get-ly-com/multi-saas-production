-- Ledger entries from stock need their own source types
ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type = ANY (ARRAY[
  'manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note', 'bank', 'closing',
  'asset', 'depreciation', 'vendor_credit', 'revenue', 'intercompany', 'invoice_cost', 'stock_adjustment'
]));

-- Opening stock already says so, without repeating its reason
CREATE OR REPLACE FUNCTION inventory.adjust_stock(
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
      CASE WHEN p_opening THEN 'Opening stock' ELSE 'Stock adjustment' || coalesce(': ' || moved.reason, '') END
        || ' (' || (SELECT name FROM inventory.items WHERE id = p_item) || ')',
      'stock_adjustment', moved.id, NULL,
      accounting.transfer_lines(p_tenant, '1400', CASE WHEN p_opening THEN '3000' ELSE '5100' END, moved.cost));
  END IF;

  SELECT * INTO updated FROM inventory.items WHERE id = p_item;
  RETURN updated;
END;
$$;
