-- "1 day more" rather than "1 days more"
CREATE OR REPLACE FUNCTION hr.check_allowance(p_tenant UUID, p_employee UUID, p_type UUID, p_year INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  balance JSON;
  over NUMERIC;
BEGIN
  SELECT b INTO balance FROM json_array_elements(hr.leave_balances(p_tenant, p_employee, p_year)) b
    WHERE (b->>'leave_type_id')::uuid = p_type;
  IF (balance->>'limited')::boolean AND (balance->>'left')::numeric < 0 THEN
    over := trim_scale(-(balance->>'left')::numeric);
    RAISE EXCEPTION 'That''s % % more % than is left for % (the allowance is % days%). An owner or admin can raise it.',
      over, CASE WHEN over = 1 THEN 'day' ELSE 'days' END, lower(balance->>'name'), p_year, balance->>'allowance',
      CASE WHEN (balance->>'carried_over')::numeric > 0 THEN ' + ' || (balance->>'carried_over') || ' carried over' ELSE '' END;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION hr.check_allowance(UUID, UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
