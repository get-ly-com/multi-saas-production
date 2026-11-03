-- Leave balances read as whole or half days, and the over-allowance message says how far over it is

CREATE OR REPLACE FUNCTION hr.leave_balances(p_tenant UUID, p_employee UUID, p_year INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  year_start DATE := make_date(p_year, 1, 1);
  year_end DATE := make_date(p_year, 12, 31);
  share NUMERIC;
BEGIN
  IF NOT hr.can_see_employee(p_tenant, p_employee) THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  SELECT * INTO person FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  -- Someone who starts or leaves during the year gets that share of the allowance
  share := greatest(0, least(year_end, coalesce(person.end_date, year_end)) - greatest(year_start, person.start_date) + 1)::numeric
    / (year_end - year_start + 1);

  RETURN coalesce((
    SELECT json_agg(json_build_object(
      'leave_type_id', b.id, 'name', b.name, 'paid', b.paid, 'limited', b.limited,
      'allowance', trim_scale(b.allowance), 'taken', trim_scale(b.taken), 'pending', trim_scale(b.pending),
      'left', CASE WHEN b.limited THEN trim_scale(b.allowance - b.taken - b.pending) END
    ) ORDER BY b.name)
    FROM (
      SELECT t.id, t.name, t.paid, t.days_per_year > 0 AS limited, round(t.days_per_year * share * 2) / 2 AS allowance,
        coalesce(used.taken, 0) AS taken, coalesce(used.pending, 0) AS pending
      FROM hr.leave_types t
      LEFT JOIN LATERAL (
        SELECT sum(r.days) FILTER (WHERE r.status = 'approved') AS taken,
               sum(r.days) FILTER (WHERE r.status = 'pending') AS pending
        FROM hr.leave_requests r
        WHERE r.employee_id = p_employee AND r.leave_type_id = t.id AND r.start_date BETWEEN year_start AND year_end
      ) used ON true
      WHERE t.tenant_id = p_tenant AND (t.is_active OR used.taken IS NOT NULL OR used.pending IS NOT NULL)
    ) b
  ), '[]'::json);
END;
$$;

CREATE OR REPLACE FUNCTION hr.check_allowance(p_tenant UUID, p_employee UUID, p_type UUID, p_year INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  balance JSON;
BEGIN
  SELECT b INTO balance FROM json_array_elements(hr.leave_balances(p_tenant, p_employee, p_year)) b
    WHERE (b->>'leave_type_id')::uuid = p_type;
  IF (balance->>'limited')::boolean AND (balance->>'left')::numeric < 0 THEN
    RAISE EXCEPTION 'That''s % days more % than is left for % (the allowance is % days). An owner or admin can raise it.',
      trim_scale(-(balance->>'left')::numeric), lower(balance->>'name'), p_year, balance->>'allowance';
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION hr.check_allowance(UUID, UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
