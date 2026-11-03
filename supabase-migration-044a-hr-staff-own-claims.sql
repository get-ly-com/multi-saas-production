-- Staff are usually viewers. Their own time and their own expense claims are theirs to enter, so viewers
-- linked to an employee can claim and cancel their own expenses, as they can clock in. Deciding for
-- someone else (approving time or claims, fixing their time) needs a role above viewer, as with leave.

CREATE OR REPLACE FUNCTION hr.submit_expense(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  v_employee UUID := nullif(p_data->>'employee_id', '')::uuid;
  v_date DATE := nullif(p_data->>'expense_date', '')::date;
  v_category UUID := nullif(p_data->>'category_id', '')::uuid;
  v_description TEXT := btrim(coalesce(p_data->>'description', ''));
  v_amount NUMERIC := round(nullif(p_data->>'amount', '')::numeric, 2);
  v_path TEXT := nullif(p_data->>'receipt_path', '');
  v_prefix TEXT;
  v_meta JSONB;
  v_size BIGINT;
  v_mime TEXT;
  next_number INT;
  claim hr.expense_claims;
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  SELECT * INTO person FROM hr.employees WHERE id = v_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF NOT hr.is_manager(p_tenant) AND person.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You can only claim your own expenses';
  END IF;
  IF v_date IS NULL OR v_date > current_date + 1 OR v_date < current_date - 365 THEN
    RAISE EXCEPTION 'Choose the date you spent it, within the last year';
  END IF;
  IF v_date < person.start_date - 60 THEN
    RAISE EXCEPTION 'That date is before this person started';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hr.expense_categories WHERE id = v_category AND tenant_id = p_tenant AND is_active) THEN
    RAISE EXCEPTION 'Choose a category';
  END IF;
  IF length(v_description) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Say what it was for, in up to 300 characters';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount >= 1e8 THEN
    RAISE EXCEPTION 'Enter an amount more than zero';
  END IF;

  IF v_path IS NOT NULL THEN
    v_prefix := p_tenant::text || '/' || v_employee::text || '/';
    IF length(v_path) > 500 OR left(v_path, length(v_prefix)) <> v_prefix OR length(v_path) = length(v_prefix)
        OR position('/' IN substr(v_path, length(v_prefix) + 1)) > 0 THEN
      RAISE EXCEPTION 'The receipt isn''t in the right place';
    END IF;
    SELECT metadata INTO v_meta FROM storage.objects WHERE bucket_id = 'hr-receipts' AND name = v_path;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The receipt wasn''t uploaded. Please try again.';
    END IF;
    v_size := (v_meta->>'size')::bigint;
    v_mime := v_meta->>'mimetype';
    IF v_size IS NULL OR v_size <= 0 OR v_size > 5242880 THEN
      RAISE EXCEPTION 'Receipts can be up to 5 MB';
    END IF;
    IF v_mime IS NULL OR v_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') THEN
      RAISE EXCEPTION 'Add the receipt as a PDF, JPEG, PNG or WebP file';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('hr.expense_claims:' || p_tenant::text, 0));
  IF v_size IS NOT NULL AND (SELECT coalesce(sum(receipt_size), 0) FROM hr.expense_claims WHERE tenant_id = p_tenant) + v_size > 209715200 THEN
    RAISE EXCEPTION 'Your company has used its 200 MB of receipt space. An owner or admin can remove old receipts.';
  END IF;
  SELECT coalesce(max(claim_number), 0) + 1 INTO next_number FROM hr.expense_claims WHERE tenant_id = p_tenant;
  INSERT INTO hr.expense_claims (tenant_id, claim_number, employee_id, expense_date, category_id, description, amount,
      receipt_path, receipt_size, receipt_mime, created_by)
    VALUES (p_tenant, next_number, v_employee, v_date, v_category, v_description, v_amount, v_path, v_size, v_mime, auth.uid())
    RETURNING * INTO claim;

  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT p_tenant, d.uid, btrim(person.first_name || ' ' || person.last_name) || ' sent an expense claim',
      hr.expense_summary(claim), '/saas/hr/expenses', 'expense:' || claim.id || ':submitted'
    FROM hr.leave_deciders(p_tenant, v_employee, ARRAY[auth.uid(), person.user_id]) AS d(uid)
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  RETURN row_to_json(claim);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That receipt is already on another claim';
END;
$$;

CREATE OR REPLACE FUNCTION hr.cancel_expense(p_tenant UUID, p_claim UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  claim hr.expense_claims;
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  SELECT * INTO claim FROM hr.expense_claims WHERE id = p_claim AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR NOT (hr.can_see_employee(p_tenant, claim.employee_id) OR hr.handles_expenses(p_tenant)) THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;
  IF NOT hr.is_manager(p_tenant) AND NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = claim.employee_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only the person, an owner or an admin can cancel this';
  END IF;
  IF claim.status <> 'submitted' THEN
    RAISE EXCEPTION 'This claim has already been %', claim.status;
  END IF;
  UPDATE hr.expense_claims SET status = 'cancelled', decided_by = auth.uid(), decided_at = now() WHERE id = p_claim
    RETURNING * INTO claim;
  RETURN row_to_json(claim);
END;
$$;

CREATE OR REPLACE FUNCTION hr.approve_attendance(p_tenant UUID, p_employee UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count INT;
  v_hours NUMERIC;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 62 THEN
    RAISE EXCEPTION 'Choose up to two months';
  END IF;
  IF NOT hr.decides_for(p_tenant, p_employee) THEN
    RAISE EXCEPTION 'Only this person''s manager, an owner or an admin can approve their time';
  END IF;
  WITH done AS (
    UPDATE hr.attendance SET approved_by = auth.uid(), approved_at = now()
    WHERE tenant_id = p_tenant AND employee_id = p_employee AND work_date BETWEEN p_from AND p_to
      AND check_out IS NOT NULL AND approved_at IS NULL
    RETURNING hours)
  SELECT count(*), coalesce(sum(hours), 0) INTO v_count, v_hours FROM done;
  RETURN json_build_object('approved', v_count, 'hours', v_hours);
END;
$$;

CREATE OR REPLACE FUNCTION hr.save_attendance(p_tenant UUID, p_entry UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  existing hr.attendance;
  person hr.employees;
  v_employee UUID;
  v_in TIMESTAMPTZ := nullif(p_data->>'check_in', '')::timestamptz;
  v_out TIMESTAMPTZ := nullif(p_data->>'check_out', '')::timestamptz;
  v_break INT := coalesce(nullif(p_data->>'break_minutes', '')::int, 0);
  v_note TEXT := nullif(btrim(coalesce(p_data->>'note', '')), '');
  v_tz TEXT := hr.valid_tz(p_data->>'tz');
  v_date DATE;
  is_self BOOLEAN;
  row_id UUID := p_entry;
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF row_id IS NOT NULL THEN
    SELECT * INTO existing FROM hr.attendance WHERE id = row_id AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Time entry not found';
    END IF;
    v_employee := existing.employee_id;
  ELSE
    v_employee := nullif(p_data->>'employee_id', '')::uuid;
  END IF;
  SELECT * INTO person FROM hr.employees WHERE id = v_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  is_self := person.user_id = auth.uid();
  IF NOT hr.decides_for(p_tenant, v_employee) AND NOT is_self THEN
    RAISE EXCEPTION 'Only this person, their manager, an owner or an admin can change their time';
  END IF;
  IF NOT is_self THEN
    PERFORM accounting.require_member(p_tenant);
  END IF;
  IF existing.approved_at IS NOT NULL AND NOT hr.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'This time is approved. Ask an owner or admin to change it.';
  END IF;

  IF v_in IS NULL THEN
    RAISE EXCEPTION 'Enter the time in';
  END IF;
  IF v_in > now() + interval '5 minutes' OR v_out > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Times can''t be in the future';
  END IF;
  IF v_out IS NOT NULL AND v_out <= v_in THEN
    RAISE EXCEPTION 'The time out must be after the time in';
  END IF;
  IF v_out - v_in > interval '24 hours' THEN
    RAISE EXCEPTION 'One entry can be up to 24 hours';
  END IF;
  IF v_break < 0 OR v_break > 600 OR (v_out IS NOT NULL AND v_break * interval '1 minute' >= v_out - v_in) THEN
    RAISE EXCEPTION 'The break must be shorter than the time worked';
  END IF;
  IF length(v_note) > 300 THEN
    RAISE EXCEPTION 'Keep the note under 300 characters';
  END IF;
  v_date := coalesce(nullif(p_data->>'work_date', '')::date, (v_in AT TIME ZONE v_tz)::date);
  IF abs(v_date - (v_in AT TIME ZONE 'UTC')::date) > 1 THEN
    RAISE EXCEPTION 'The day must match the time in';
  END IF;
  IF v_date < person.start_date OR v_date > coalesce(person.end_date, v_date) THEN
    RAISE EXCEPTION 'That day is outside this person''s employment';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('hr.attendance:' || v_employee::text, 0));
  IF EXISTS (SELECT 1 FROM hr.attendance a WHERE a.employee_id = v_employee AND a.id IS DISTINCT FROM row_id
      AND tstzrange(a.check_in, coalesce(a.check_out, 'infinity')) && tstzrange(v_in, coalesce(v_out, 'infinity'))) THEN
    RAISE EXCEPTION 'This overlaps another time entry';
  END IF;
  IF v_out IS NULL AND EXISTS (SELECT 1 FROM hr.attendance WHERE employee_id = v_employee AND check_out IS NULL
      AND id IS DISTINCT FROM row_id) THEN
    RAISE EXCEPTION 'This person is already clocked in';
  END IF;

  IF row_id IS NULL THEN
    INSERT INTO hr.attendance (tenant_id, employee_id, work_date, check_in, check_out, break_minutes, source, note, created_by)
      VALUES (p_tenant, v_employee, v_date, v_in, v_out, v_break, 'manual', v_note, auth.uid())
      RETURNING id INTO row_id;
  ELSE
    UPDATE hr.attendance SET work_date = v_date, check_in = v_in, check_out = v_out, break_minutes = v_break,
        note = v_note, updated_at = now(),
        approved_by = CASE WHEN approved_at IS NOT NULL AND v_out IS NOT NULL THEN auth.uid() END,
        approved_at = CASE WHEN approved_at IS NOT NULL AND v_out IS NOT NULL THEN now() END
      WHERE id = row_id;
  END IF;
  RETURN (SELECT row_to_json(a) FROM hr.attendance a WHERE id = row_id);
END;
$$;

CREATE OR REPLACE FUNCTION hr.delete_attendance(p_tenant UUID, p_entry UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry hr.attendance;
BEGIN
  SELECT * INTO entry FROM hr.attendance WHERE id = p_entry AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR NOT (hr.can_see_employee(p_tenant, entry.employee_id)) THEN
    RAISE EXCEPTION 'Time entry not found';
  END IF;
  IF entry.approved_at IS NOT NULL AND NOT hr.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'This time is approved. Ask an owner or admin to change it.';
  END IF;
  IF NOT hr.decides_for(p_tenant, entry.employee_id)
      AND NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = entry.employee_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only this person, their manager, an owner or an admin can change their time';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = entry.employee_id AND user_id = auth.uid()) THEN
    PERFORM accounting.require_member(p_tenant);
  END IF;
  DELETE FROM hr.attendance WHERE id = p_entry;
  RETURN json_build_object('success', true);
END;
$$;


NOTIFY pgrst, 'reload schema';
