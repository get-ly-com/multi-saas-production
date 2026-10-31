-- Run after supabase-migration-002. Already applied to the production project.
-- Services now query as the signed-in user, so the database enforces tenant separation.
GRANT USAGE ON SCHEMA accounting, crm, inventory TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  accounting.invoices, accounting.expenses, crm.contacts, crm.deals TO authenticated;

-- Stock counts only change through adjust_stock, so the history stays complete.
GRANT SELECT, DELETE ON inventory.items TO authenticated;
GRANT INSERT (tenant_id, sku, name, price, reorder_level) ON inventory.items TO authenticated;
GRANT UPDATE (sku, name, price, reorder_level, updated_at) ON inventory.items TO authenticated;
GRANT SELECT ON inventory.movements TO authenticated;

CREATE POLICY tenant_rows ON accounting.invoices FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON accounting.expenses FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON crm.contacts FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON crm.deals FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON inventory.items FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));
CREATE POLICY tenant_rows ON inventory.movements FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid())));

-- Definer rights let it write the stock count, so it checks membership itself.
CREATE OR REPLACE FUNCTION inventory.adjust_stock(p_tenant UUID, p_item UUID, p_change INT, p_reason TEXT)
RETURNS inventory.items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  updated inventory.items;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Item not found';
  END IF;
  UPDATE inventory.items
    SET quantity = quantity + p_change, updated_at = now()
    WHERE id = p_item AND tenant_id = p_tenant
    RETURNING * INTO updated;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found';
  END IF;
  INSERT INTO inventory.movements (tenant_id, item_id, change, reason)
    VALUES (p_tenant, p_item, p_change, p_reason);
  RETURN updated;
END;
$$;
REVOKE EXECUTE ON FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
