-- Unused leave carried over to the next year, up to a limit set on each leave type (0 = nothing carries over)

ALTER TABLE hr.leave_types ADD COLUMN max_carry_over NUMERIC(5,1) NOT NULL DEFAULT 0 CHECK (max_carry_over >= 0);
GRANT INSERT (max_carry_over) ON hr.leave_types TO authenticated;
GRANT UPDATE (max_carry_over) ON hr.leave_types TO authenticated;

-- Carry over is whole or half days and never more than the days a year
CREATE FUNCTION hr.check_leave_type()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.max_carry_over * 2 <> round(NEW.max_carry_over * 2) THEN
    RAISE EXCEPTION 'Carry over must be whole or half days';
  END IF;
  IF NEW.max_carry_over > NEW.days_per_year THEN
    RAISE EXCEPTION 'Carry over can''t be more than the days a year (%)', trim_scale(NEW.days_per_year);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION hr.check_leave_type() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER check_leave_type BEFORE INSERT OR UPDATE OF days_per_year, max_carry_over ON hr.leave_types
  FOR EACH ROW EXECUTE FUNCTION hr.check_leave_type();

-- 'carried_over' is what was left unused last year, up to the type's limit. It only looks one year back:
-- days carried into last year don't carry on again. Last year's allowance uses today's days a year
-- and last year's share for starters and leavers, so someone who started this year carries nothing.
CREATE OR REPLACE FUNCTION hr.leave_balances(p_tenant UUID, p_employee UUID, p_year INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  year_start DATE := make_date(p_year, 1, 1);
  year_end DATE := make_date(p_year, 12, 31);
  last_start DATE := make_date(p_year - 1, 1, 1);
  last_end DATE := make_date(p_year - 1, 12, 31);
  share NUMERIC;
  last_share NUMERIC;
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
  last_share := greatest(0, least(last_end, coalesce(person.end_date, last_end)) - greatest(last_start, person.start_date) + 1)::numeric
    / (last_end - last_start + 1);

  RETURN coalesce((
    SELECT json_agg(json_build_object(
      'leave_type_id', b.id, 'name', b.name, 'paid', b.paid, 'limited', b.limited,
      'allowance', trim_scale(b.allowance), 'carried_over', trim_scale(b.carried_over),
      'taken', trim_scale(b.taken), 'pending', trim_scale(b.pending),
      'left', CASE WHEN b.limited THEN trim_scale(b.allowance + b.carried_over - b.taken - b.pending) END
    ) ORDER BY b.name)
    FROM (
      SELECT t.id, t.name, t.paid, t.days_per_year > 0 AS limited, round(t.days_per_year * share * 2) / 2 AS allowance,
        CASE WHEN t.days_per_year > 0 THEN
          greatest(0, least(t.max_carry_over, round(t.days_per_year * last_share * 2) / 2 - coalesce(last_year.taken, 0)))
        ELSE 0 END AS carried_over,
        coalesce(used.taken, 0) AS taken, coalesce(used.pending, 0) AS pending
      FROM hr.leave_types t
      LEFT JOIN LATERAL (
        SELECT sum(r.days) FILTER (WHERE r.status = 'approved') AS taken,
               sum(r.days) FILTER (WHERE r.status = 'pending') AS pending
        FROM hr.leave_requests r
        WHERE r.employee_id = p_employee AND r.leave_type_id = t.id AND r.start_date BETWEEN year_start AND year_end
      ) used ON true
      LEFT JOIN LATERAL (
        -- Only approved leave counts against last year
        SELECT sum(r.days) AS taken
        FROM hr.leave_requests r
        WHERE r.employee_id = p_employee AND r.leave_type_id = t.id AND r.status = 'approved'
          AND r.start_date BETWEEN last_start AND last_end
      ) last_year ON t.max_carry_over > 0
      WHERE t.tenant_id = p_tenant AND (t.is_active OR used.taken IS NOT NULL OR used.pending IS NOT NULL)
    ) b
  ), '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION hr.leave_balances(UUID, UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hr.leave_balances(UUID, UUID, INT) TO authenticated;

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
    RAISE EXCEPTION 'That''s % days more % than is left for % (the allowance is % days%). An owner or admin can raise it.',
      trim_scale(-(balance->>'left')::numeric), lower(balance->>'name'), p_year, balance->>'allowance',
      CASE WHEN (balance->>'carried_over')::numeric > 0 THEN ' + ' || (balance->>'carried_over') || ' carried over' ELSE '' END;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION hr.check_allowance(UUID, UUID, UUID, INT) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
