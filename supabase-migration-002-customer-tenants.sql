-- Run after supabase-schema.sql. Already applied to the production project.
-- A tenant is now a customer company, not an app.
DELETE FROM public.tenants WHERE id NOT IN (SELECT tenant_id FROM accounting.invoices);
ALTER TABLE public.tenants DROP COLUMN app_name;
DROP TABLE public.users;

CREATE TABLE public.tenant_members (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX idx_tenant_members_user ON public.tenant_members(user_id);
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;

-- Signed-in users can only see their own memberships and those tenants.
CREATE POLICY members_read_own ON public.tenant_members
  FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
CREATE POLICY tenants_read_own ON public.tenants
  FOR SELECT TO authenticated USING (
    id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (select auth.uid()))
  );
GRANT SELECT ON public.tenant_members, public.tenants TO authenticated;

-- Onboarding: creates the company and its owner in one step.
CREATE FUNCTION public.create_tenant(company_name TEXT)
RETURNS public.tenants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  new_tenant public.tenants;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF length(trim(coalesce(company_name, ''))) = 0 THEN
    RAISE EXCEPTION 'Company name is required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_members WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You already belong to a company';
  END IF;
  INSERT INTO public.tenants (name) VALUES (trim(company_name)) RETURNING * INTO new_tenant;
  INSERT INTO public.tenant_members (tenant_id, user_id, role) VALUES (new_tenant.id, auth.uid(), 'owner');
  RETURN new_tenant;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.create_tenant(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_tenant(TEXT) TO authenticated;

-- Accounting
ALTER TABLE accounting.invoices
  ADD COLUMN customer_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN customer_email TEXT,
  ADD COLUMN due_date DATE,
  ADD COLUMN paid_at TIMESTAMP,
  ADD COLUMN line_items JSONB NOT NULL DEFAULT '[]',
  ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  ADD CONSTRAINT invoices_amount_check CHECK (amount >= 0);
ALTER TABLE accounting.expenses
  ADD COLUMN expense_date DATE NOT NULL DEFAULT current_date,
  ADD CONSTRAINT expenses_amount_check CHECK (amount >= 0);

-- CRM
ALTER TABLE crm.contacts ADD COLUMN notes TEXT;
ALTER TABLE crm.deals
  ADD COLUMN updated_at TIMESTAMP DEFAULT now(),
  ADD CONSTRAINT deals_stage_check CHECK (stage IN ('prospecting', 'qualified', 'proposal', 'won', 'lost'));
CREATE INDEX idx_deals_contact ON crm.deals(contact_id);

-- Inventory
ALTER TABLE inventory.items
  ADD COLUMN reorder_level INT NOT NULL DEFAULT 0,
  ADD COLUMN updated_at TIMESTAMP DEFAULT now(),
  ADD CONSTRAINT items_quantity_check CHECK (quantity >= 0);

CREATE TABLE inventory.movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory.items(id) ON DELETE CASCADE,
  change INT NOT NULL CHECK (change <> 0),
  reason TEXT,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_movements_tenant ON inventory.movements(tenant_id);
CREATE INDEX idx_movements_item ON inventory.movements(item_id);
ALTER TABLE inventory.movements ENABLE ROW LEVEL SECURITY;
GRANT ALL ON inventory.movements TO service_role;

-- Updates the stock count and its history together, so they cannot disagree.
CREATE FUNCTION inventory.adjust_stock(p_tenant UUID, p_item UUID, p_change INT, p_reason TEXT)
RETURNS inventory.items
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  updated inventory.items;
BEGIN
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
REVOKE EXECUTE ON FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION inventory.adjust_stock(UUID, UUID, INT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
