-- Private notes on staff stay with owners and admins, even when accountants may run payroll and
-- read pay. The notes column can't be read directly; owners and admins get it from employee_notes.

REVOKE SELECT ON hr.compensation FROM authenticated;
GRANT SELECT (employee_id, tenant_id, pay_type, amount, hours_per_week, updated_at) ON hr.compensation TO authenticated;

CREATE FUNCTION hr.employee_notes(p_tenant UUID, p_employee UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT hr.is_manager(p_tenant) THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT notes FROM hr.compensation WHERE employee_id = p_employee AND tenant_id = p_tenant);
END;
$$;
REVOKE EXECUTE ON FUNCTION hr.employee_notes(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hr.employee_notes(UUID, UUID) TO authenticated;
