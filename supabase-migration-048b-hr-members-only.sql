-- Only current members of a company see its HR records. Someone who left but whose staff record is
-- still linked to their sign-in no longer sees their old attendance, leave or claims there.
CREATE OR REPLACE FUNCTION hr.can_see_employee(p_tenant uuid, p_employee uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT hr.is_manager(p_tenant) OR (hr.is_member(p_tenant) AND EXISTS (
    SELECT 1 FROM hr.employees e
    LEFT JOIN hr.employees m ON m.id = e.manager_id
    WHERE e.id = p_employee AND e.tenant_id = p_tenant
      AND (e.user_id = auth.uid() OR m.user_id = auth.uid())));
$$;

CREATE OR REPLACE FUNCTION hr.my_visible_employees()
RETURNS TABLE(tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER ROWS 10 SET search_path = ''
AS $$
  SELECT v.tenant_id, v.id FROM (
    SELECT e.tenant_id, e.id FROM hr.employees e WHERE e.user_id = auth.uid()
    UNION
    SELECT e.tenant_id, e.id FROM hr.employees e JOIN hr.employees m ON m.id = e.manager_id WHERE m.user_id = auth.uid()
  ) v
  WHERE v.tenant_id IN (SELECT tm.tenant_id FROM public.tenant_members tm WHERE tm.user_id = auth.uid());
$$;
