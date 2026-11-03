-- Scheduler, closer to Odoo Appointments.
-- 1. Group sessions: a service can take several people at the same time (a class or a workshop).
--    The database still refuses two different things for one person at once; people in the same
--    session share it, and a session never takes more people than it has places.
--    Video group sessions share one Jitsi room.
-- 2. Questions on the booking form, per service. Answers are kept on the booking and written on
--    the CRM contact's timeline.
-- 3. Visitors can move their own booking from their private link (up to 3 times), to free times
--    with the same person. Leave, holidays, notice and double-booking checks all still apply.
-- 4. Add to calendar: a visitor can download their booking as an .ics file, and each team member
--    can subscribe to a private, read-only calendar feed of their own bookings.
-- 5. Attended / no-show marking, a follow-up list (who to remind in the next 2 days, who still
--    needs marking) and booking reports.
-- 6. Repeat bookings made by staff (every 1, 2 or 4 weeks); dates that can't be booked are skipped
--    and listed.
-- Nothing is renamed: columns are only added to scheduler.bookings and scheduler.services.

-- ---------------------------------------------------------------- Tables
ALTER TABLE scheduler.services
  ADD COLUMN IF NOT EXISTS capacity INT NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS questions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) <= 10);

ALTER TABLE scheduler.bookings
  ADD COLUMN IF NOT EXISTS session_key UUID,
  ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(answers) = 'array'),
  ADD COLUMN IF NOT EXISTS attendance TEXT CHECK (attendance IN ('attended', 'no_show')),
  ADD COLUMN IF NOT EXISTS attendance_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attendance_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS visitor_moves INT NOT NULL DEFAULT 0 CHECK (visitor_moves BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS repeat_group UUID;
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_session ON scheduler.bookings (session_key) WHERE session_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_repeat ON scheduler.bookings (repeat_group) WHERE repeat_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_attendance_by ON scheduler.bookings (attendance_by);
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_reminded_by ON scheduler.bookings (reminded_by);

-- One person, one thing at a time, except people sharing the same group session.
-- A one-to-one booking has no session, so it counts as its own and clashes with everything.
ALTER TABLE scheduler.bookings DROP CONSTRAINT IF EXISTS no_double_booking;
ALTER TABLE scheduler.bookings ADD CONSTRAINT no_double_booking EXCLUDE USING gist (
  staff_id WITH =, tstzrange(starts_at, blocked_until) WITH &&, (coalesce(session_key, id)) WITH <>)
  WHERE (status = 'booked');

-- The secret in each team member's calendar feed link. Nobody can read this table directly.
CREATE TABLE IF NOT EXISTS scheduler.calendar_feeds (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_calendar_feeds_user ON scheduler.calendar_feeds (user_id);
ALTER TABLE scheduler.calendar_feeds ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- Helpers
-- The session a group booking belongs to: same service, same person, same start
CREATE OR REPLACE FUNCTION scheduler.session_key_of(p_service UUID, p_staff UUID, p_start TIMESTAMPTZ)
RETURNS UUID
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT md5(p_service::text || '/' || p_staff::text || '/' || extract(epoch FROM p_start)::text)::uuid;
$$;

CREATE OR REPLACE FUNCTION scheduler.seats_taken(p_key UUID, p_ignore UUID)
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT count(*)::int FROM scheduler.bookings
  WHERE session_key = p_key AND status = 'booked' AND id IS DISTINCT FROM p_ignore;
$$;

-- Checks and tidies the questions a manager sets on a service
CREATE OR REPLACE FUNCTION scheduler.clean_questions(p_questions JSONB)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  q JSONB;
  result JSONB := '[]'::jsonb;
  kind TEXT;
  label TEXT;
  qid TEXT;
  seen TEXT[] := '{}';
  opts JSONB;
  opt TEXT;
BEGIN
  IF p_questions IS NULL OR jsonb_typeof(p_questions) = 'null' THEN
    RETURN '[]'::jsonb;
  END IF;
  IF jsonb_typeof(p_questions) <> 'array' OR jsonb_array_length(p_questions) > 10 THEN
    RAISE EXCEPTION 'Add up to 10 questions';
  END IF;
  FOR q IN SELECT * FROM jsonb_array_elements(p_questions) LOOP
    IF jsonb_typeof(q) <> 'object' THEN
      RAISE EXCEPTION 'Each question needs a label';
    END IF;
    label := btrim(coalesce(q->>'label', ''));
    kind := coalesce(nullif(q->>'kind', ''), 'text');
    IF length(label) = 0 OR length(label) > 200 THEN
      RAISE EXCEPTION 'Each question needs a label of up to 200 characters';
    END IF;
    IF kind NOT IN ('text', 'long', 'choice', 'yes_no') THEN
      RAISE EXCEPTION 'Choose the kind of answer for each question';
    END IF;
    qid := coalesce(q->>'id', '');
    IF qid !~ '^[a-z0-9]{6,16}$' OR qid = ANY (seen) THEN
      qid := encode(extensions.gen_random_bytes(5), 'hex');
    END IF;
    seen := seen || qid;
    opts := '[]'::jsonb;
    IF kind = 'choice' THEN
      IF jsonb_typeof(coalesce(q->'options', 'null'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION 'Give "%" 2 to 10 options', label;
      END IF;
      FOR opt IN SELECT btrim(x) FROM jsonb_array_elements_text(q->'options') x LOOP
        CONTINUE WHEN opt = '' OR opts ? opt;
        IF length(opt) > 100 THEN
          RAISE EXCEPTION 'Options can be up to 100 characters';
        END IF;
        opts := opts || to_jsonb(opt);
      END LOOP;
      IF jsonb_array_length(opts) < 2 OR jsonb_array_length(opts) > 10 THEN
        RAISE EXCEPTION 'Give "%" 2 to 10 options', label;
      END IF;
    END IF;
    result := result || jsonb_build_array(jsonb_build_object('id', qid, 'label', label, 'kind', kind,
      'required', coalesce(q->>'required', '') = 'true', 'options', opts));
  END LOOP;
  RETURN result;
END;
$$;

-- Checks answers against a service's questions. Returns [{id, label, answer}] so the booking keeps
-- the question as it was asked. Required questions are enforced on the public page only.
CREATE OR REPLACE FUNCTION scheduler.clean_answers(p_questions JSONB, p_answers JSONB, p_enforce BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  q JSONB;
  a TEXT;
  result JSONB := '[]'::jsonb;
BEGIN
  IF p_answers IS NOT NULL AND jsonb_typeof(p_answers) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'Answer the questions';
  END IF;
  FOR q IN SELECT * FROM jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) LOOP
    a := CASE WHEN jsonb_typeof(p_answers->(q->>'id')) IN ('string', 'number', 'boolean')
      THEN btrim(p_answers->>(q->>'id')) ELSE '' END;
    IF a = '' THEN
      IF p_enforce AND coalesce((q->>'required')::boolean, false) THEN
        RAISE EXCEPTION 'Please answer: %', q->>'label';
      END IF;
      CONTINUE;
    END IF;
    IF length(a) > (CASE WHEN q->>'kind' = 'long' THEN 2000 ELSE 300 END) THEN
      RAISE EXCEPTION 'Your answer to "%" is too long', q->>'label';
    END IF;
    IF q->>'kind' = 'choice' AND NOT (coalesce(q->'options', '[]'::jsonb) ? a) THEN
      RAISE EXCEPTION 'Choose one of the options for: %', q->>'label';
    END IF;
    IF q->>'kind' = 'yes_no' AND a NOT IN ('Yes', 'No') THEN
      RAISE EXCEPTION 'Answer yes or no for: %', q->>'label';
    END IF;
    result := result || jsonb_build_array(jsonb_build_object('id', q->>'id', 'label', q->>'label', 'answer', a));
  END LOOP;
  RETURN result;
END;
$$;

-- ---------------------------------------------------------------- Free times
-- Free start times. Hours and days off are in the company's time zone. A start is free when the
-- whole service plus its buffer fits in the person's hours and touches no other booking or meeting.
-- Company holidays (HR) and the person's approved leave (HR) close the whole day; a half day
-- of leave closes the whole day too. For a group service, a start that already has a session
-- is free while it has places left.
CREATE OR REPLACE FUNCTION scheduler.free_slots(p_tenant UUID, p_service UUID, p_staff UUID, p_from DATE, p_to DATE,
  p_notice BOOLEAN, p_ignore_booking UUID)
RETURNS TABLE (slot_start TIMESTAMPTZ, slot_staff UUID)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s scheduler.settings;
  svc scheduler.services;
  zone TEXT;
  earliest TIMESTAMPTZ;
  latest TIMESTAMPTZ;
BEGIN
  SELECT * INTO s FROM scheduler.settings WHERE tenant_id = p_tenant;
  SELECT * INTO svc FROM scheduler.services WHERE id = p_service AND tenant_id = p_tenant;
  IF svc.id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 42 THEN
    RETURN;
  END IF;
  zone := coalesce(s.time_zone, 'UTC');
  IF p_notice THEN
    earliest := now() + coalesce(s.min_notice_minutes, 120) * interval '1 minute';
    latest := (((now() AT TIME ZONE zone)::date + coalesce(s.max_days_ahead, 60) + 1)::timestamp) AT TIME ZONE zone;
  ELSE
    earliest := now();
    latest := 'infinity';
  END IF;

  RETURN QUERY
  WITH people AS (
    SELECT st.user_id FROM scheduler.staff st
    JOIN public.tenant_members tm ON tm.tenant_id = st.tenant_id AND tm.user_id = st.user_id
    WHERE st.tenant_id = p_tenant AND st.is_bookable
      AND (p_staff IS NULL OR st.user_id = p_staff)
      AND (cardinality(svc.staff_ids) = 0 OR st.user_id = ANY (svc.staff_ids))
  ), windows AS (
    SELECT p.user_id,
      (d.day + h.start_time) AT TIME ZONE zone AS w_start,
      (d.day + h.end_time) AT TIME ZONE zone AS w_end
    FROM people p
    JOIN scheduler.hours h ON h.tenant_id = p_tenant AND h.user_id = p.user_id
    JOIN (SELECT g::date AS day FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
      ON extract(dow FROM d.day) = h.weekday
    WHERE NOT EXISTS (SELECT 1 FROM scheduler.days_off o WHERE o.tenant_id = p_tenant AND o.off_date = d.day
      AND (o.user_id IS NULL OR o.user_id = p.user_id))
      AND NOT EXISTS (SELECT 1 FROM hr.holidays hd WHERE hd.tenant_id = p_tenant AND hd.holiday_date = d.day)
      AND NOT EXISTS (SELECT 1 FROM hr.leave_requests l JOIN hr.employees e ON e.id = l.employee_id
        WHERE l.tenant_id = p_tenant AND e.tenant_id = p_tenant AND e.user_id = p.user_id
          AND l.status = 'approved' AND d.day BETWEEN l.start_date AND l.end_date)
  ), candidates AS (
    SELECT w.user_id, g AS slot,
      CASE WHEN svc.capacity > 1 THEN scheduler.session_key_of(svc.id, w.user_id, g) END AS skey
    FROM windows w,
      generate_series(w.w_start, w.w_end - svc.duration_minutes * interval '1 minute',
        coalesce(s.slot_step_minutes, 30) * interval '1 minute') g
  )
  SELECT c.slot, c.user_id FROM candidates c
  WHERE c.slot >= earliest AND c.slot < latest
    AND NOT EXISTS (
      SELECT 1 FROM scheduler.bookings b
      WHERE b.staff_id = c.user_id AND b.status = 'booked' AND b.id IS DISTINCT FROM p_ignore_booking
        AND tstzrange(b.starts_at, b.blocked_until)
          && tstzrange(c.slot, c.slot + (svc.duration_minutes + svc.buffer_minutes) * interval '1 minute')
        AND (c.skey IS NULL OR coalesce(b.session_key, b.id) <> c.skey))
    AND (c.skey IS NULL OR scheduler.seats_taken(c.skey, p_ignore_booking) < svc.capacity)
    AND NOT EXISTS (
      SELECT 1 FROM scheduler.meetings m
      WHERE m.tenant_id = p_tenant AND m.host_id = c.user_id AND m.status = 'scheduled'
        AND NOT EXISTS (SELECT 1 FROM scheduler.bookings b2 WHERE b2.meeting_id = m.id)
        AND tstzrange(m.starts_at, m.starts_at + m.duration_minutes * interval '1 minute')
          && tstzrange(c.slot, c.slot + svc.duration_minutes * interval '1 minute'))
  ORDER BY c.slot, c.user_id;
END;
$$;

-- Free times for a visitor page, one row per start time, with places left for group services
CREATE OR REPLACE FUNCTION scheduler.slots_json(p_tenant UUID, p_service UUID, p_person UUID, p_from DATE, p_to DATE, p_ignore UUID)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(json_agg(json_build_object('start', f.slot_start,
      'date', to_char(f.slot_start AT TIME ZONE z.zone, 'YYYY-MM-DD'),
      'time', to_char(f.slot_start AT TIME ZONE z.zone, 'HH24:MI'),
      'seats_left', f.seats_left) ORDER BY f.slot_start), '[]'::json)
  FROM (
    SELECT x.slot_start,
      CASE WHEN v.capacity > 1
        THEN max(v.capacity - scheduler.seats_taken(scheduler.session_key_of(v.id, x.slot_staff, x.slot_start), p_ignore)) END AS seats_left
    FROM scheduler.free_slots(p_tenant, p_service, p_person, p_from, p_to, true, p_ignore) x
    CROSS JOIN (SELECT sv.id, sv.capacity FROM scheduler.services sv WHERE sv.id = p_service) v
    GROUP BY x.slot_start, v.capacity
  ) f
  CROSS JOIN (SELECT scheduler.tz(p_tenant) AS zone) z;
$$;

-- Free start times for staff making a booking. Staff aren't held to the minimum notice.
CREATE OR REPLACE FUNCTION scheduler.free_times(p_tenant UUID, p_service UUID, p_staff UUID, p_date DATE, p_booking UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  zone TEXT := scheduler.tz(p_tenant);
BEGIN
  IF NOT scheduler.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN coalesce((SELECT json_agg(json_build_object('start', f.slot_start, 'time', to_char(f.slot_start AT TIME ZONE zone, 'HH24:MI'),
      'staff_id', f.slot_staff, 'staff_name', st.display_name,
      'seats_left', CASE WHEN v.capacity > 1
        THEN v.capacity - scheduler.seats_taken(scheduler.session_key_of(v.id, f.slot_staff, f.slot_start), p_booking) END)
      ORDER BY f.slot_start, st.display_name)
    FROM scheduler.free_slots(p_tenant, p_service, p_staff, p_date, p_date, false, p_booking) f
    JOIN scheduler.staff st ON st.tenant_id = p_tenant AND st.user_id = f.slot_staff
    CROSS JOIN (SELECT sv.id, sv.capacity FROM scheduler.services sv WHERE sv.id = p_service AND sv.tenant_id = p_tenant) v), '[]'::json);
END;
$$;

-- ---------------------------------------------------------------- What screens show
CREATE OR REPLACE FUNCTION scheduler.booking_json(p_booking UUID)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT (json_build_object(
    'id', b.id, 'service_id', b.service_id, 'service_name', v.name, 'staff_id', b.staff_id,
    'staff_name', coalesce(st.display_name, 'Former team member'),
    'starts_at', b.starts_at, 'ends_at', b.ends_at,
    'local_date', to_char(b.starts_at AT TIME ZONE z.zone, 'YYYY-MM-DD'),
    'start_time', to_char(b.starts_at AT TIME ZONE z.zone, 'HH24:MI'),
    'end_time', to_char(b.ends_at AT TIME ZONE z.zone, 'HH24:MI'),
    'status', b.status, 'customer_name', b.customer_name, 'customer_email', b.customer_email,
    'customer_phone', b.customer_phone, 'notes', b.notes, 'location_type', b.location_type,
    'location_detail', b.location_detail, 'contact_id', b.contact_id, 'meeting_id', b.meeting_id,
    'room_url', CASE WHEN b.status = 'booked' THEN m.room_url END, 'source', b.source,
    'cancelled_at', b.cancelled_at, 'cancelled_by_visitor', b.cancelled_by_visitor, 'cancel_reason', b.cancel_reason,
    'created_at', b.created_at,
    'invoice_id', b.invoice_id, 'invoice_number', i.invoice_number, 'invoice_status', i.status,
    'invoice_note', b.invoice_note, 'campaign', b.campaign)::jsonb
  || jsonb_build_object(
    'capacity', v.capacity, 'session_key', b.session_key,
    'seats_taken', CASE WHEN b.session_key IS NOT NULL THEN scheduler.seats_taken(b.session_key, NULL) END,
    'answers', b.answers, 'attendance', b.attendance, 'attendance_at', b.attendance_at,
    'reminded_at', b.reminded_at, 'visitor_moves', b.visitor_moves, 'repeat_group', b.repeat_group,
    'has_started', b.starts_at <= now()))::json
  FROM scheduler.bookings b
  JOIN scheduler.services v ON v.id = b.service_id
  CROSS JOIN LATERAL (SELECT scheduler.tz(b.tenant_id) AS zone) z
  LEFT JOIN scheduler.staff st ON st.tenant_id = b.tenant_id AND st.user_id = b.staff_id
  LEFT JOIN scheduler.meetings m ON m.id = b.meeting_id
  LEFT JOIN accounting.invoices i ON i.id = b.invoice_id
  WHERE b.id = p_booking;
$$;

-- What a visitor sees about their own booking
CREATE OR REPLACE FUNCTION scheduler.visitor_json(p_booking UUID)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'company', t.name, 'service', v.name, 'with', coalesce(st.display_name, t.name),
    'when', scheduler.when_text(b.starts_at, z.zone), 'starts_at', b.starts_at, 'ends_at', b.ends_at,
    'local_date', to_char(b.starts_at AT TIME ZONE z.zone, 'YYYY-MM-DD'),
    'start_time', to_char(b.starts_at AT TIME ZONE z.zone, 'HH24:MI'),
    'end_time', to_char(b.ends_at AT TIME ZONE z.zone, 'HH24:MI'),
    'time_zone', z.zone, 'location_type', b.location_type, 'location_detail', b.location_detail,
    'room_url', CASE WHEN b.status = 'booked' THEN m.room_url END,
    'status', b.status, 'can_cancel', b.status = 'booked' AND b.starts_at > now(), 'name', b.customer_name,
    'group', v.capacity > 1, 'answers', b.answers,
    'can_reschedule', b.status = 'booked' AND b.starts_at > now() AND b.visitor_moves < 3 AND v.is_active
      AND coalesce(s.booking_enabled, false) AND t.is_active IS NOT FALSE,
    'moves_left', greatest(0, 3 - b.visitor_moves))
  FROM scheduler.bookings b
  JOIN public.tenants t ON t.id = b.tenant_id
  JOIN scheduler.services v ON v.id = b.service_id
  CROSS JOIN LATERAL (SELECT scheduler.tz(b.tenant_id) AS zone) z
  LEFT JOIN scheduler.settings s ON s.tenant_id = b.tenant_id
  LEFT JOIN scheduler.staff st ON st.tenant_id = b.tenant_id AND st.user_id = b.staff_id
  LEFT JOIN scheduler.meetings m ON m.id = b.meeting_id
  WHERE b.id = p_booking;
$$;

-- ---------------------------------------------------------------- Booking
-- Every booking, from staff or the public page, goes through here.
-- p_customer may hold 'override_away' (staff only, after a warning), 'campaign' (public only)
-- and 'answers' ({question id: answer}).
CREATE OR REPLACE FUNCTION scheduler.place_booking(p_tenant UUID, p_service UUID, p_staff UUID, p_start TIMESTAMPTZ,
  p_customer JSONB, p_contact UUID, p_source TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  svc scheduler.services;
  zone TEXT := scheduler.tz(p_tenant);
  who TEXT := btrim(coalesce(p_customer->>'name', ''));
  address TEXT := lower(btrim(coalesce(p_customer->>'email', '')));
  phone_number TEXT := btrim(coalesce(p_customer->>'phone', ''));
  note TEXT := nullif(btrim(coalesce(p_customer->>'notes', '')), '');
  camp TEXT := CASE WHEN p_source = 'public' THEN nullif(btrim(coalesce(p_customer->>'campaign', '')), '') END;
  contact UUID := p_contact;
  staff_name TEXT;
  meeting UUID;
  booking UUID;
  activity UUID;
  ends TIMESTAMPTZ;
  said_when TEXT;
  away TEXT;
  skey UUID;
  given JSONB;
  answers_text TEXT;
  taken INT;
BEGIN
  SELECT * INTO svc FROM scheduler.services WHERE id = p_service AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service not found';
  END IF;
  IF NOT svc.is_active THEN
    RAISE EXCEPTION 'This service is turned off';
  END IF;
  SELECT st.display_name INTO staff_name FROM scheduler.staff st
    JOIN public.tenant_members tm ON tm.tenant_id = st.tenant_id AND tm.user_id = st.user_id
    WHERE st.tenant_id = p_tenant AND st.user_id = p_staff;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose who the booking is with';
  END IF;
  IF p_start IS NULL THEN
    RAISE EXCEPTION 'Choose a date and time';
  END IF;
  IF length(who) = 0 OR length(who) > 200 THEN
    RAISE EXCEPTION 'Enter a name';
  END IF;
  IF length(address) > 254 OR (length(address) > 0 AND address !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'Enter a valid email';
  END IF;
  IF length(phone_number) > 40 OR length(coalesce(note, '')) > 2000 THEN
    RAISE EXCEPTION 'That is too long';
  END IF;
  IF length(coalesce(camp, '')) > 100 THEN
    RAISE EXCEPTION 'The campaign name is too long';
  END IF;
  IF svc.location_type = 'phone' AND phone_number = '' THEN
    RAISE EXCEPTION 'Enter a phone number for the call';
  END IF;
  given := scheduler.clean_answers(svc.questions, p_customer->'answers', p_source = 'public');

  ends := p_start + svc.duration_minutes * interval '1 minute';

  -- Leave and holidays. Staff can book anyway after a warning, the same way typed times may go
  -- outside opening hours; the public page never can.
  away := scheduler.away_during(p_tenant, p_staff, p_start, ends);
  IF away IS NOT NULL AND NOT (p_source = 'staff' AND coalesce(p_customer->>'override_away', '') = 'true') THEN
    RAISE EXCEPTION '%', away;
  END IF;

  -- Group session: one at a time per session, so the last place can't be taken twice
  IF svc.capacity > 1 THEN
    skey := scheduler.session_key_of(svc.id, p_staff, p_start);
    PERFORM pg_advisory_xact_lock(hashtextextended(skey::text, 45));
    taken := scheduler.seats_taken(skey, NULL);
    IF taken >= svc.capacity THEN
      RAISE EXCEPTION 'This session is full. Please pick another time.';
    END IF;
    IF address <> '' AND EXISTS (SELECT 1 FROM scheduler.bookings x WHERE x.session_key = skey AND x.status = 'booked'
        AND lower(x.customer_email) = address) THEN
      RAISE EXCEPTION 'This email is already booked on this session';
    END IF;
  END IF;

  IF contact IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM crm.contacts WHERE id = contact AND tenant_id = p_tenant) THEN
      RAISE EXCEPTION 'Contact not found';
    END IF;
  ELSE
    contact := scheduler.find_contact(p_tenant, who, address, phone_number, p_staff, camp);
  END IF;

  said_when := scheduler.when_text(p_start, zone);

  IF svc.location_type = 'video' THEN
    -- People in one group session share its room
    IF skey IS NOT NULL THEN
      SELECT x.meeting_id INTO meeting FROM scheduler.bookings x
        WHERE x.session_key = skey AND x.status = 'booked' AND x.meeting_id IS NOT NULL LIMIT 1;
    END IF;
    IF meeting IS NULL THEN
      INSERT INTO scheduler.meetings (tenant_id, title, starts_at, duration_minutes, room_url, host_id, created_by)
        VALUES (p_tenant, left(CASE WHEN skey IS NOT NULL THEN svc.name || ' (group session)' ELSE svc.name || ' with ' || who END, 200),
          p_start, svc.duration_minutes, scheduler.room_url(p_tenant), p_staff, auth.uid())
        RETURNING id INTO meeting;
    END IF;
    IF contact IS NOT NULL THEN
      INSERT INTO scheduler.meeting_contacts (meeting_id, contact_id, tenant_id) VALUES (meeting, contact, p_tenant)
        ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  BEGIN
    INSERT INTO scheduler.bookings (tenant_id, service_id, staff_id, starts_at, ends_at, blocked_until,
      customer_name, customer_email, customer_phone, notes, location_type, location_detail, contact_id,
      meeting_id, source, created_by, campaign, session_key, answers)
    VALUES (p_tenant, svc.id, p_staff, p_start, ends, ends + svc.buffer_minutes * interval '1 minute',
      who, nullif(address, ''), nullif(phone_number, ''), note, svc.location_type, svc.location_detail, contact,
      meeting, p_source, auth.uid(), camp, skey, given)
    RETURNING id INTO booking;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time is already booked. Please pick another time.';
  END;

  INSERT INTO scheduler.booking_tokens (booking_id, token) VALUES (booking, encode(extensions.gen_random_bytes(32), 'hex'));

  IF contact IS NOT NULL THEN
    SELECT string_agg((x->>'label') || ': ' || (x->>'answer'), E'\n') INTO answers_text FROM jsonb_array_elements(given) x;
    INSERT INTO crm.activities (tenant_id, kind, subject, body, contact_id, owner_id)
      VALUES (p_tenant, 'meeting', left(svc.name || ' on ' || said_when, 300),
        left(concat_ws(E'\n',
          CASE WHEN p_source = 'public' THEN 'Booked online with ' ELSE 'Booked by the team with ' END || staff_name,
          CASE svc.location_type WHEN 'video' THEN 'Video call' WHEN 'phone' THEN 'Phone call' ELSE 'In person' END
            || coalesce(': ' || svc.location_detail, ''),
          CASE WHEN skey IS NOT NULL THEN 'Group session (' || (taken + 1) || ' of ' || svc.capacity || ' places taken)' END,
          note,
          answers_text), 10000),
        contact, p_staff)
      RETURNING id INTO activity;
    UPDATE scheduler.bookings SET activity_id = activity WHERE id = booking;
  END IF;

  -- Paid service: a draft invoice. A problem here never stops the booking; it is noted instead.
  IF coalesce(svc.price, 0) > 0
     AND coalesce((SELECT draft_invoices FROM scheduler.settings WHERE tenant_id = p_tenant), true) THEN
    IF contact IS NULL THEN
      UPDATE scheduler.bookings SET invoice_note = 'No draft invoice was made because the booking has no email or CRM contact'
        WHERE id = booking;
    ELSE
      BEGIN
        PERFORM scheduler.draft_invoice(booking);
      EXCEPTION WHEN OTHERS THEN
        UPDATE scheduler.bookings SET invoice_note = left('No draft invoice was made: ' || SQLERRM, 300) WHERE id = booking;
      END;
    END IF;
  END IF;

  PERFORM scheduler.notify(p_tenant, p_staff, 'New booking: ' || who,
    svc.name || ', ' || said_when || CASE WHEN skey IS NOT NULL THEN ' (' || (taken + 1) || ' of ' || svc.capacity || ' places taken)' ELSE '' END,
    '/saas/scheduler?date=' || to_char(p_start AT TIME ZONE zone, 'YYYY-MM-DD'), 'booking:' || booking || ':booked');
  RETURN booking;
END;
$$;

-- Cancelling. A shared group room stays open while anyone else is still booked on it.
CREATE OR REPLACE FUNCTION scheduler.do_cancel(p_booking UUID, p_reason TEXT, p_by_visitor BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
  svc_name TEXT;
  said_when TEXT;
  reason TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  inv accounting.invoices;
BEGIN
  SELECT * INTO b FROM scheduler.bookings WHERE id = p_booking FOR UPDATE;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'This booking is already cancelled';
  END IF;
  IF length(coalesce(reason, '')) > 500 THEN
    RAISE EXCEPTION 'That is too long';
  END IF;
  SELECT name INTO svc_name FROM scheduler.services WHERE id = b.service_id;
  said_when := scheduler.when_text(b.starts_at, scheduler.tz(b.tenant_id));

  UPDATE scheduler.bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by_visitor = p_by_visitor,
    cancel_reason = reason, updated_at = now() WHERE id = b.id;
  UPDATE scheduler.meetings SET status = 'cancelled' WHERE id = b.meeting_id
    AND NOT EXISTS (SELECT 1 FROM scheduler.bookings x WHERE x.meeting_id = b.meeting_id AND x.status = 'booked' AND x.id <> b.id);

  -- A draft invoice goes with the booking (Accounting lets drafts be deleted). A sent one stays.
  IF b.invoice_id IS NOT NULL THEN
    SELECT * INTO inv FROM accounting.invoices WHERE id = b.invoice_id;
    IF inv.status = 'draft' THEN
      BEGIN
        DELETE FROM accounting.invoices WHERE id = inv.id AND status = 'draft';
        UPDATE scheduler.bookings SET invoice_note = left('Draft invoice ' || inv.invoice_number
          || ' was deleted when the booking was cancelled', 300) WHERE id = b.id;
      EXCEPTION WHEN OTHERS THEN
        UPDATE scheduler.bookings SET invoice_note = left('Draft invoice ' || inv.invoice_number
          || ' could not be deleted. Delete it in Accounting.', 300) WHERE id = b.id;
      END;
    ELSIF inv.status IS NOT NULL AND inv.status <> 'void' THEN
      UPDATE scheduler.bookings SET invoice_note = left('Invoice ' || inv.invoice_number
        || ' was already sent, so it was kept. Credit or void it in Accounting if needed.', 300) WHERE id = b.id;
    END IF;
  END IF;

  IF b.contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm.contacts WHERE id = b.contact_id) THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, body, contact_id, owner_id)
      VALUES (b.tenant_id, 'note', left('Cancelled: ' || svc_name || ' on ' || said_when, 300),
        concat_ws(E'\n', CASE WHEN p_by_visitor THEN 'Cancelled by ' || b.customer_name ELSE 'Cancelled by the team' END, reason),
        b.contact_id, scheduler.current_member(b.tenant_id, b.staff_id));
  END IF;

  PERFORM scheduler.notify(b.tenant_id, b.staff_id,
    CASE WHEN p_by_visitor THEN b.customer_name || ' cancelled' ELSE 'Booking cancelled: ' || b.customer_name END,
    concat_ws('. ', svc_name || ', ' || said_when, reason),
    '/saas/scheduler?date=' || to_char(b.starts_at AT TIME ZONE scheduler.tz(b.tenant_id), 'YYYY-MM-DD'),
    'booking:' || b.id || ':cancelled');
END;
$$;

-- Moves a booking to a new time or person, keeping its length and buffer. The caller has
-- checked who may do it and whether the time is allowed. A draft invoice's line follows the new
-- date. A person moving out of a shared group room gets a room of their own (or the new session's).
CREATE OR REPLACE FUNCTION scheduler.do_move(p_booking UUID, p_start TIMESTAMPTZ, p_staff UUID, p_by_visitor BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
  svc scheduler.services;
  zone TEXT;
  new_key UUID;
  target_meeting UUID;
  shared BOOLEAN;
  said_when TEXT;
  day_link TEXT;
  new_day DATE;
BEGIN
  SELECT * INTO b FROM scheduler.bookings WHERE id = p_booking FOR UPDATE;
  SELECT * INTO svc FROM scheduler.services WHERE id = b.service_id;
  zone := scheduler.tz(b.tenant_id);

  IF svc.capacity > 1 THEN
    new_key := scheduler.session_key_of(svc.id, p_staff, p_start);
    PERFORM pg_advisory_xact_lock(hashtextextended(new_key::text, 45));
    IF scheduler.seats_taken(new_key, b.id) >= svc.capacity THEN
      RAISE EXCEPTION 'That session is full. Please pick another time.';
    END IF;
    IF b.customer_email IS NOT NULL AND EXISTS (SELECT 1 FROM scheduler.bookings x WHERE x.session_key = new_key
        AND x.status = 'booked' AND x.id <> b.id AND lower(x.customer_email) = lower(b.customer_email)) THEN
      RAISE EXCEPTION 'This email is already booked on that session';
    END IF;
  END IF;

  BEGIN
    UPDATE scheduler.bookings SET
      starts_at = p_start,
      ends_at = p_start + (b.ends_at - b.starts_at),
      blocked_until = p_start + (b.blocked_until - b.starts_at),
      staff_id = p_staff,
      session_key = new_key,
      reminded_at = NULL,
      reminded_by = NULL,
      updated_at = now()
    WHERE id = b.id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time is already booked. Please pick another time.';
  END;

  IF b.meeting_id IS NOT NULL THEN
    shared := EXISTS (SELECT 1 FROM scheduler.bookings x WHERE x.meeting_id = b.meeting_id AND x.id <> b.id AND x.status = 'booked');
    IF new_key IS NOT NULL THEN
      SELECT x.meeting_id INTO target_meeting FROM scheduler.bookings x
        WHERE x.session_key = new_key AND x.status = 'booked' AND x.id <> b.id
          AND x.meeting_id IS NOT NULL AND x.meeting_id <> b.meeting_id LIMIT 1;
    END IF;
    IF target_meeting IS NOT NULL OR shared THEN
      IF target_meeting IS NULL THEN
        INSERT INTO scheduler.meetings (tenant_id, title, starts_at, duration_minutes, room_url, host_id, created_by)
          VALUES (b.tenant_id, left(CASE WHEN new_key IS NOT NULL THEN svc.name || ' (group session)' ELSE svc.name || ' with ' || b.customer_name END, 200),
            p_start, (EXTRACT(epoch FROM (b.ends_at - b.starts_at)) / 60)::int, scheduler.room_url(b.tenant_id), p_staff, auth.uid())
          RETURNING id INTO target_meeting;
      END IF;
      UPDATE scheduler.bookings SET meeting_id = target_meeting WHERE id = b.id;
      IF b.contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm.contacts WHERE id = b.contact_id) THEN
        INSERT INTO scheduler.meeting_contacts (meeting_id, contact_id, tenant_id) VALUES (target_meeting, b.contact_id, b.tenant_id)
          ON CONFLICT DO NOTHING;
        IF shared AND NOT EXISTS (SELECT 1 FROM scheduler.bookings x WHERE x.meeting_id = b.meeting_id AND x.id <> b.id
            AND x.status = 'booked' AND x.contact_id = b.contact_id) THEN
          DELETE FROM scheduler.meeting_contacts WHERE meeting_id = b.meeting_id AND contact_id = b.contact_id;
        END IF;
      END IF;
      IF NOT shared THEN
        UPDATE scheduler.meetings SET status = 'cancelled' WHERE id = b.meeting_id;
      END IF;
    ELSE
      UPDATE scheduler.meetings SET starts_at = p_start, host_id = p_staff WHERE id = b.meeting_id;
    END IF;
  END IF;

  new_day := (p_start AT TIME ZONE zone)::date;
  IF b.invoice_id IS NOT NULL THEN
    BEGIN
      UPDATE accounting.invoices SET
        line_items = jsonb_set(line_items, '{0,description}',
          to_jsonb(left(svc.name || ' on ' || to_char(new_day, 'DD Mon YYYY'), 500))),
        due_date = greatest(current_date, new_day), updated_at = now()
      WHERE id = b.invoice_id AND status = 'draft' AND jsonb_array_length(line_items) = 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- The invoice was changed in Accounting; leave it as it is
    END;
  END IF;

  said_when := scheduler.when_text(p_start, zone);
  day_link := '/saas/scheduler?date=' || to_char(p_start AT TIME ZONE zone, 'YYYY-MM-DD');
  IF b.contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm.contacts WHERE id = b.contact_id) THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, body, contact_id, owner_id)
      VALUES (b.tenant_id, 'meeting', left('Moved: ' || svc.name || ' to ' || said_when, 300),
        concat_ws(E'\n', 'Was ' || scheduler.when_text(b.starts_at, zone),
          CASE WHEN p_by_visitor THEN 'Moved by ' || b.customer_name || ' from their booking link' END),
        b.contact_id, p_staff);
  END IF;
  PERFORM scheduler.notify(b.tenant_id, p_staff,
    CASE WHEN p_by_visitor THEN b.customer_name || ' moved their booking' ELSE 'Booking moved: ' || b.customer_name END,
    svc.name || ', now ' || said_when,
    day_link, 'booking:' || b.id || ':moved:' || extract(epoch FROM p_start)::bigint || ':' || p_staff);
  IF b.staff_id IS DISTINCT FROM p_staff THEN
    PERFORM scheduler.notify(b.tenant_id, b.staff_id, 'Booking handed over: ' || b.customer_name,
      svc.name || ' on ' || scheduler.when_text(b.starts_at, zone) || ' is now with someone else', day_link,
      'booking:' || b.id || ':handover:' || extract(epoch FROM p_start)::bigint);
  END IF;
END;
$$;

-- Moves a booking to a new time or person, keeping its length and buffer. Leave and holidays
-- need the same confirmation as a new booking. A draft invoice's line follows the new date.
CREATE OR REPLACE FUNCTION scheduler.reschedule_booking(p_tenant UUID, p_booking UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
  zone TEXT := scheduler.tz(p_tenant);
  new_start TIMESTAMPTZ;
  new_staff UUID;
  away TEXT;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  SELECT * INTO b FROM scheduler.bookings WHERE id = p_booking AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'This booking is cancelled';
  END IF;
  new_start := scheduler.local_start(zone, p_data->>'date', p_data->>'time');
  new_staff := coalesce(nullif(p_data->>'staff_id', '')::uuid, b.staff_id);
  IF NOT EXISTS (SELECT 1 FROM scheduler.staff st JOIN public.tenant_members tm ON tm.tenant_id = st.tenant_id AND tm.user_id = st.user_id
      WHERE st.tenant_id = p_tenant AND st.user_id = new_staff) THEN
    RAISE EXCEPTION 'Choose who the booking is with';
  END IF;
  IF new_start = b.starts_at AND new_staff IS NOT DISTINCT FROM b.staff_id THEN
    RETURN scheduler.booking_json(b.id);
  END IF;
  away := scheduler.away_during(p_tenant, new_staff, new_start, new_start + (b.ends_at - b.starts_at));
  IF away IS NOT NULL AND coalesce(p_data->>'override_away', '') <> 'true' THEN
    RAISE EXCEPTION '%', away;
  END IF;
  PERFORM scheduler.do_move(b.id, new_start, new_staff, false);
  RETURN scheduler.booking_json(b.id);
END;
$$;

-- ---------------------------------------------------------------- Services
CREATE OR REPLACE FUNCTION scheduler.save_service(p_tenant UUID, p_service UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  people UUID[];
  row_id UUID;
  label TEXT := btrim(coalesce(p_data->>'name', ''));
  kind TEXT := coalesce(p_data->>'location_type', 'in_person');
  cost NUMERIC;
  places INT;
  asked JSONB;
  busiest INT;
BEGIN
  PERFORM scheduler.require_manager(p_tenant);
  IF length(label) = 0 OR length(label) > 100 THEN
    RAISE EXCEPTION 'Enter a name';
  END IF;
  IF kind NOT IN ('in_person', 'phone', 'video') THEN
    RAISE EXCEPTION 'Choose where it happens';
  END IF;
  IF nullif(p_data->>'price', '') IS NOT NULL THEN
    IF (p_data->>'price') !~ '^\d{1,9}(\.\d{1,2})?$' THEN
      RAISE EXCEPTION 'Enter a valid price';
    END IF;
    cost := (p_data->>'price')::numeric;
  END IF;
  IF jsonb_typeof(coalesce(p_data->'staff_ids', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Choose who offers it';
  END IF;
  people := ARRAY(SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(coalesce(p_data->'staff_ids', '[]'::jsonb)) x);
  IF EXISTS (SELECT 1 FROM unnest(people) pid WHERE NOT EXISTS (
      SELECT 1 FROM scheduler.staff st WHERE st.tenant_id = p_tenant AND st.user_id = pid)) THEN
    RAISE EXCEPTION 'Someone you chose has not set up their hours yet';
  END IF;
  places := scheduler.int_of(coalesce(nullif(p_data->>'capacity', ''), '1'), 1, 200, 'Places must be between 1 and 200');
  asked := scheduler.clean_questions(p_data->'questions');

  IF p_service IS NULL THEN
    INSERT INTO scheduler.services (tenant_id, name, description, duration_minutes, buffer_minutes, price,
      location_type, location_detail, staff_ids, capacity, questions)
    VALUES (p_tenant, label, nullif(btrim(coalesce(p_data->>'description', '')), ''),
      scheduler.int_of(p_data->>'duration_minutes', 5, 480, 'Length must be between 5 and 480 minutes'),
      scheduler.int_of(coalesce(nullif(p_data->>'buffer_minutes', ''), '0'), 0, 240, 'Buffer must be between 0 and 240 minutes'),
      cost, kind, nullif(btrim(coalesce(p_data->>'location_detail', '')), ''), people, places, asked)
    RETURNING id INTO row_id;
  ELSE
    -- Fewer places than people already booked on an upcoming session would overfill it
    SELECT max(n) INTO busiest FROM (
      SELECT count(*) AS n FROM scheduler.bookings
      WHERE service_id = p_service AND tenant_id = p_tenant AND status = 'booked' AND starts_at > now()
      GROUP BY coalesce(session_key, id)) x;
    IF coalesce(busiest, 0) > places THEN
      RAISE EXCEPTION 'An upcoming session already has % people booked. Set at least % places.', busiest, busiest;
    END IF;
    UPDATE scheduler.services SET
      name = label,
      description = nullif(btrim(coalesce(p_data->>'description', '')), ''),
      duration_minutes = scheduler.int_of(p_data->>'duration_minutes', 5, 480, 'Length must be between 5 and 480 minutes'),
      buffer_minutes = scheduler.int_of(coalesce(nullif(p_data->>'buffer_minutes', ''), '0'), 0, 240, 'Buffer must be between 0 and 240 minutes'),
      price = cost,
      location_type = kind,
      location_detail = nullif(btrim(coalesce(p_data->>'location_detail', '')), ''),
      staff_ids = people,
      is_active = coalesce((p_data->>'is_active')::boolean, is_active),
      capacity = places,
      questions = asked,
      updated_at = now()
    WHERE id = p_service AND tenant_id = p_tenant
    RETURNING id INTO row_id;
    IF row_id IS NULL THEN
      RAISE EXCEPTION 'Service not found';
    END IF;
    -- A one-to-one service that becomes a group: its upcoming bookings start their sessions
    IF places > 1 THEN
      UPDATE scheduler.bookings SET session_key = scheduler.session_key_of(service_id, staff_id, starts_at)
        WHERE service_id = row_id AND status = 'booked' AND starts_at > now() AND session_key IS NULL AND staff_id IS NOT NULL;
    END IF;
  END IF;
  RETURN (SELECT row_to_json(v) FROM scheduler.services v WHERE v.id = row_id);
EXCEPTION
  WHEN unique_violation THEN RAISE EXCEPTION 'A service with that name already exists';
  WHEN check_violation THEN RAISE EXCEPTION 'Something in the form is too long';
END;
$$;

-- ---------------------------------------------------------------- Repeat bookings (staff)
-- The same booking every 1, 2 or 4 weeks. Each date goes through the normal checks; a date that
-- is taken, closed or on leave is skipped and listed instead of stopping the rest.
CREATE OR REPLACE FUNCTION scheduler.create_repeat_bookings(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  zone TEXT := scheduler.tz(p_tenant);
  every INT;
  times INT;
  first_day DATE;
  day DATE;
  booking UUID;
  grp UUID := gen_random_uuid();
  made JSONB := '[]'::jsonb;
  skipped JSONB := '[]'::jsonb;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  IF coalesce(p_data->>'every_weeks', '') NOT IN ('1', '2', '4') THEN
    RAISE EXCEPTION 'Choose how often it repeats';
  END IF;
  every := (p_data->>'every_weeks')::int;
  times := scheduler.int_of(p_data->>'times', 2, 26, 'Repeat between 2 and 26 times');
  PERFORM scheduler.local_start(zone, p_data->>'date', p_data->>'time');
  first_day := (p_data->>'date')::date;

  FOR i IN 0 .. times - 1 LOOP
    day := first_day + i * every * 7;
    BEGIN
      booking := scheduler.place_booking(p_tenant, (p_data->>'service_id')::uuid, (p_data->>'staff_id')::uuid,
        scheduler.local_start(zone, to_char(day, 'YYYY-MM-DD'), p_data->>'time'),
        p_data - 'campaign', nullif(p_data->>'contact_id', '')::uuid, 'staff');
      UPDATE scheduler.bookings SET repeat_group = grp WHERE id = booking;
      made := made || jsonb_build_array(scheduler.booking_json(booking)::jsonb);
    EXCEPTION WHEN raise_exception THEN
      skipped := skipped || jsonb_build_array(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'reason', SQLERRM));
    END;
  END LOOP;
  IF jsonb_array_length(made) = 0 THEN
    RAISE EXCEPTION 'Nothing was booked: %', skipped->0->>'reason';
  END IF;
  RETURN json_build_object('made', made, 'skipped', skipped, 'repeat_group', grp);
END;
$$;

-- Cancels this booking and the later ones it repeats with
CREATE OR REPLACE FUNCTION scheduler.cancel_repeats(p_tenant UUID, p_booking UUID, p_reason TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
  row_id UUID;
  n INT := 0;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  SELECT * INTO b FROM scheduler.bookings WHERE id = p_booking AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  IF b.repeat_group IS NULL THEN
    RAISE EXCEPTION 'This booking does not repeat';
  END IF;
  FOR row_id IN SELECT id FROM scheduler.bookings WHERE tenant_id = p_tenant AND repeat_group = b.repeat_group
      AND status = 'booked' AND starts_at >= b.starts_at ORDER BY starts_at LOOP
    PERFORM scheduler.do_cancel(row_id, p_reason, false);
    n := n + 1;
  END LOOP;
  RETURN json_build_object('cancelled', n);
END;
$$;

-- ---------------------------------------------------------------- Attendance, reminders, reports
CREATE OR REPLACE FUNCTION scheduler.mark_attendance(p_tenant UUID, p_booking UUID, p_value TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
  val TEXT := nullif(btrim(coalesce(p_value, '')), '');
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  SELECT * INTO b FROM scheduler.bookings WHERE id = p_booking AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'This booking is cancelled';
  END IF;
  IF b.starts_at > now() THEN
    RAISE EXCEPTION 'You can mark this once the booking has started';
  END IF;
  IF val IS NOT NULL AND val NOT IN ('attended', 'no_show') THEN
    RAISE EXCEPTION 'Choose attended or no-show';
  END IF;
  UPDATE scheduler.bookings SET attendance = val,
    attendance_at = CASE WHEN val IS NULL THEN NULL ELSE now() END,
    attendance_by = CASE WHEN val IS NULL THEN NULL ELSE auth.uid() END,
    updated_at = now()
  WHERE id = b.id;
  IF val = 'no_show' AND b.attendance IS DISTINCT FROM 'no_show'
     AND b.contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm.contacts WHERE id = b.contact_id) THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, contact_id, owner_id)
      VALUES (p_tenant, 'note', left('No-show: ' || (SELECT name FROM scheduler.services WHERE id = b.service_id)
        || ' on ' || scheduler.when_text(b.starts_at, scheduler.tz(p_tenant)), 300),
        b.contact_id, scheduler.current_member(p_tenant, b.staff_id));
  END IF;
  RETURN scheduler.booking_json(b.id);
END;
$$;

-- We don't send reminders, so staff tick off who they have reminded themselves
CREATE OR REPLACE FUNCTION scheduler.mark_reminded(p_tenant UUID, p_booking UUID, p_done BOOLEAN)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  UPDATE scheduler.bookings SET
    reminded_at = CASE WHEN p_done THEN now() END,
    reminded_by = CASE WHEN p_done THEN auth.uid() END
  WHERE id = p_booking AND tenant_id = p_tenant AND status = 'booked';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  RETURN scheduler.booking_json(p_booking);
END;
$$;

-- Who to remind in the next 2 days, and past bookings (30 days) not yet marked attended or no-show
CREATE OR REPLACE FUNCTION scheduler.follow_up(p_tenant UUID, p_staff UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT scheduler.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN json_build_object(
    'time_zone', scheduler.tz(p_tenant),
    'to_remind', coalesce((SELECT json_agg(scheduler.booking_json(x.id) ORDER BY x.starts_at) FROM (
      SELECT b.id, b.starts_at FROM scheduler.bookings b
      WHERE b.tenant_id = p_tenant AND b.status = 'booked' AND b.starts_at > now() AND b.starts_at < now() + interval '2 days'
        AND (p_staff IS NULL OR b.staff_id = p_staff)
      ORDER BY b.starts_at LIMIT 200) x), '[]'::json),
    'to_mark', coalesce((SELECT json_agg(scheduler.booking_json(x.id) ORDER BY x.starts_at DESC) FROM (
      SELECT b.id, b.starts_at FROM scheduler.bookings b
      WHERE b.tenant_id = p_tenant AND b.status = 'booked' AND b.attendance IS NULL
        AND b.starts_at <= now() AND b.starts_at > now() - interval '30 days'
        AND (p_staff IS NULL OR b.staff_id = p_staff)
      ORDER BY b.starts_at DESC LIMIT 200) x), '[]'::json));
END;
$$;

-- Booking numbers for a date range (company time zone), by service and by person
CREATE OR REPLACE FUNCTION scheduler.stats(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  zone TEXT := scheduler.tz(p_tenant);
  from_at TIMESTAMPTZ;
  to_at TIMESTAMPTZ;
BEGIN
  IF NOT scheduler.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Choose up to a year';
  END IF;
  from_at := p_from::timestamp AT TIME ZONE zone;
  to_at := (p_to + 1)::timestamp AT TIME ZONE zone;
  RETURN (
    WITH b AS (
      SELECT x.*, v.name AS service_name, v.capacity, coalesce(st.display_name, 'Former team member') AS staff_name
      FROM scheduler.bookings x
      JOIN scheduler.services v ON v.id = x.service_id
      LEFT JOIN scheduler.staff st ON st.tenant_id = x.tenant_id AND st.user_id = x.staff_id
      WHERE x.tenant_id = p_tenant AND x.starts_at >= from_at AND x.starts_at < to_at
    ), totals AS (
      SELECT count(*) AS total,
        count(*) FILTER (WHERE status = 'booked') AS booked,
        count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        count(*) FILTER (WHERE status = 'cancelled' AND cancelled_by_visitor) AS cancelled_by_customer,
        count(*) FILTER (WHERE status = 'booked' AND attendance = 'attended') AS attended,
        count(*) FILTER (WHERE status = 'booked' AND attendance = 'no_show') AS no_show,
        count(*) FILTER (WHERE status = 'booked' AND attendance IS NULL AND starts_at <= now()) AS not_marked,
        count(*) FILTER (WHERE status = 'booked' AND starts_at > now()) AS upcoming,
        count(*) FILTER (WHERE source = 'public') AS online,
        count(*) FILTER (WHERE visitor_moves > 0) AS moved_by_customer
      FROM b
    )
    SELECT json_build_object(
      'from', p_from, 'to', p_to, 'time_zone', zone,
      'totals', (SELECT row_to_json(t) FROM totals t),
      'no_show_rate', (SELECT round(100.0 * no_show / nullif(attended + no_show, 0), 1) FROM totals),
      'cancel_rate', (SELECT round(100.0 * cancelled / nullif(total, 0), 1) FROM totals),
      'by_service', coalesce((SELECT json_agg(r ORDER BY r.booked DESC, r.name) FROM (
        SELECT service_name AS name, max(capacity) AS capacity,
          count(*) FILTER (WHERE status = 'booked') AS booked,
          count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
          count(*) FILTER (WHERE attendance = 'attended' AND status = 'booked') AS attended,
          count(*) FILTER (WHERE attendance = 'no_show' AND status = 'booked') AS no_show,
          count(DISTINCT coalesce(session_key, id)) FILTER (WHERE status = 'booked') AS sessions
        FROM b GROUP BY service_id, service_name) r), '[]'::json),
      'by_staff', coalesce((SELECT json_agg(r ORDER BY r.booked DESC, r.name) FROM (
        SELECT staff_name AS name,
          count(*) FILTER (WHERE status = 'booked') AS booked,
          count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
          count(*) FILTER (WHERE attendance = 'attended' AND status = 'booked') AS attended,
          count(*) FILTER (WHERE attendance = 'no_show' AND status = 'booked') AS no_show
        FROM b GROUP BY staff_id, staff_name) r), '[]'::json))
  );
END;
$$;

-- ---------------------------------------------------------------- Calendar files (.ics)
CREATE OR REPLACE FUNCTION scheduler.ics_text(p TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT replace(replace(replace(replace(replace(coalesce(p, ''), E'\\', E'\\\\'), ';', E'\\;'), ',', E'\\,'), E'\r', ''), E'\n', E'\\n');
$$;

-- Long lines are folded onto continuation lines that start with a space
CREATE OR REPLACE FUNCTION scheduler.ics_fold(p TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN length(p) <= 60 THEN p
    ELSE (SELECT string_agg(substr(p, i, 60), E'\r\n ' ORDER BY i) FROM generate_series(1, length(p), 60) i) END;
$$;

CREATE OR REPLACE FUNCTION scheduler.ics_utc(p TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"');
$$;

CREATE OR REPLACE FUNCTION scheduler.ics_event(p_uid TEXT, p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_summary TEXT,
  p_description TEXT, p_location TEXT, p_url TEXT, p_cancelled BOOLEAN, p_stamp TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT concat_ws(E'\r\n',
    'BEGIN:VEVENT',
    scheduler.ics_fold('UID:' || p_uid),
    'DTSTAMP:' || scheduler.ics_utc(p_stamp),
    'DTSTART:' || scheduler.ics_utc(p_start),
    'DTEND:' || scheduler.ics_utc(p_end),
    scheduler.ics_fold('SUMMARY:' || scheduler.ics_text(p_summary)),
    CASE WHEN nullif(p_description, '') IS NOT NULL THEN scheduler.ics_fold('DESCRIPTION:' || scheduler.ics_text(p_description)) END,
    CASE WHEN nullif(p_location, '') IS NOT NULL THEN scheduler.ics_fold('LOCATION:' || scheduler.ics_text(p_location)) END,
    CASE WHEN nullif(p_url, '') IS NOT NULL THEN scheduler.ics_fold('URL:' || p_url) END,
    'STATUS:' || CASE WHEN p_cancelled THEN 'CANCELLED' ELSE 'CONFIRMED' END,
    'END:VEVENT');
$$;

CREATE OR REPLACE FUNCTION scheduler.ics_calendar(p_name TEXT, p_events TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT concat_ws(E'\r\n', 'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Scheduler//Bookings//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', scheduler.ics_fold('X-WR-CALNAME:' || scheduler.ics_text(p_name)),
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', nullif(p_events, ''), 'END:VCALENDAR') || E'\r\n';
$$;

-- A visitor's booking as a calendar file, from the secret in their link
CREATE OR REPLACE FUNCTION public.booking_ics(p_token TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT scheduler.ics_calendar(t.name, scheduler.ics_event(b.id::text || '@booking', b.starts_at, b.ends_at,
      v.name || ' with ' || coalesce(st.display_name, t.name) || ' (' || t.name || ')',
      concat_ws(E'\n', 'Booked with ' || t.name,
        CASE WHEN b.status = 'booked' AND m.room_url IS NOT NULL THEN 'Video link: ' || m.room_url || ' (Jitsi Meet)' END,
        CASE WHEN b.location_type = 'phone' THEN 'They will call you on the number you gave.' END),
      CASE WHEN b.location_type = 'video' THEN CASE WHEN b.status = 'booked' THEN m.room_url END
        ELSE coalesce(b.location_detail, CASE WHEN b.location_type = 'phone' THEN 'Phone call' END) END,
      CASE WHEN b.status = 'booked' THEN m.room_url END,
      b.status <> 'booked', b.updated_at))
  FROM scheduler.booking_tokens k
  JOIN scheduler.bookings b ON b.id = k.booking_id
  JOIN public.tenants t ON t.id = b.tenant_id
  JOIN scheduler.services v ON v.id = b.service_id
  LEFT JOIN scheduler.staff st ON st.tenant_id = b.tenant_id AND st.user_id = b.staff_id
  LEFT JOIN scheduler.meetings m ON m.id = b.meeting_id
  WHERE coalesce(p_token, '') ~ '^[0-9a-f]{64}$' AND k.token = p_token;
$$;

-- A team member's private feed link. Calendar apps can't sign in, so the link itself is the key.
CREATE OR REPLACE FUNCTION scheduler.feed_link(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT scheduler.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN json_build_object('token',
    (SELECT token FROM scheduler.calendar_feeds WHERE tenant_id = p_tenant AND user_id = auth.uid()));
END;
$$;

CREATE OR REPLACE FUNCTION scheduler.new_feed_link(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  fresh TEXT := encode(extensions.gen_random_bytes(32), 'hex');
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  INSERT INTO scheduler.calendar_feeds (tenant_id, user_id, token) VALUES (p_tenant, auth.uid(), fresh)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET token = EXCLUDED.token, created_at = now();
  RETURN json_build_object('token', fresh);
END;
$$;

CREATE OR REPLACE FUNCTION scheduler.stop_feed_link(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT scheduler.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  DELETE FROM scheduler.calendar_feeds WHERE tenant_id = p_tenant AND user_id = auth.uid();
  RETURN json_build_object('token', NULL);
END;
$$;

-- The feed: the person's own bookings (from 60 days ago to a year ahead, one event per group
-- session) and the video meetings they host. NULL when the link is wrong or they left the company.
CREATE OR REPLACE FUNCTION public.staff_feed_ics(p_token TEXT)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  f scheduler.calendar_feeds;
  company TEXT;
  person TEXT;
  events TEXT;
BEGIN
  IF coalesce(p_token, '') !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;
  SELECT cf.* INTO f FROM scheduler.calendar_feeds cf
    JOIN public.tenant_members tm ON tm.tenant_id = cf.tenant_id AND tm.user_id = cf.user_id
    JOIN public.tenants t ON t.id = cf.tenant_id
    WHERE cf.token = p_token AND t.is_active IS NOT FALSE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT t.name INTO company FROM public.tenants t WHERE t.id = f.tenant_id;
  SELECT coalesce(st.display_name, split_part(u.email, '@', 1)) INTO person
    FROM auth.users u LEFT JOIN scheduler.staff st ON st.tenant_id = f.tenant_id AND st.user_id = u.id
    WHERE u.id = f.user_id;

  WITH booked AS (
    SELECT DISTINCT ON (coalesce(b.session_key, b.id)) b.*, v.name AS service_name, v.capacity, m.room_url
    FROM scheduler.bookings b
    JOIN scheduler.services v ON v.id = b.service_id
    LEFT JOIN scheduler.meetings m ON m.id = b.meeting_id
    WHERE b.tenant_id = f.tenant_id AND b.staff_id = f.user_id AND b.status = 'booked'
      AND b.starts_at > now() - interval '60 days' AND b.starts_at < now() + interval '366 days'
    ORDER BY coalesce(b.session_key, b.id), b.created_at
    LIMIT 2000
  ), items AS (
    SELECT x.starts_at, scheduler.ics_event(coalesce(x.session_key, x.id)::text || '@scheduler', x.starts_at, x.ends_at,
      CASE WHEN x.session_key IS NOT NULL
        THEN x.service_name || ' (group, ' || scheduler.seats_taken(x.session_key, NULL) || ' of ' || x.capacity || ' places taken)'
        ELSE x.service_name || ': ' || x.customer_name END,
      CASE WHEN x.session_key IS NOT NULL
        THEN concat_ws(E'\n', 'Booked: ' || (SELECT string_agg(g.customer_name, ', ' ORDER BY g.created_at) FROM scheduler.bookings g
            WHERE g.session_key = x.session_key AND g.status = 'booked'),
          CASE WHEN x.room_url IS NOT NULL THEN 'Video link: ' || x.room_url END)
        ELSE concat_ws(E'\n', x.customer_email, x.customer_phone, CASE WHEN x.room_url IS NOT NULL THEN 'Video link: ' || x.room_url END) END,
      CASE x.location_type WHEN 'video' THEN x.room_url
        WHEN 'phone' THEN 'Phone call' || coalesce(': ' || x.customer_phone, '')
        ELSE coalesce(x.location_detail, 'In person') END,
      x.room_url, false, x.updated_at) AS ev
    FROM booked x
    UNION ALL
    SELECT m.starts_at, scheduler.ics_event(m.id::text || '@meeting', m.starts_at, m.starts_at + m.duration_minutes * interval '1 minute',
      'Video meeting: ' || m.title, concat_ws(E'\n', 'Video link: ' || m.room_url, m.notes), m.room_url, m.room_url, false, m.created_at)
    FROM scheduler.meetings m
    WHERE m.tenant_id = f.tenant_id AND m.host_id = f.user_id AND m.status = 'scheduled'
      AND m.starts_at > now() - interval '60 days' AND m.starts_at < now() + interval '366 days'
      AND NOT EXISTS (SELECT 1 FROM scheduler.bookings b2 WHERE b2.meeting_id = m.id)
  )
  SELECT string_agg(ev, E'\r\n' ORDER BY starts_at) INTO events FROM items;
  RETURN scheduler.ics_calendar(company || ': ' || coalesce(person, 'my') || ' bookings', events);
END;
$$;

-- ---------------------------------------------------------------- Public booking page
CREATE OR REPLACE FUNCTION public.booking_page(p_key TEXT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'company', t.name, 'time_zone', s.time_zone, 'welcome', s.welcome, 'max_days_ahead', s.max_days_ahead,
    'today', to_char(now() AT TIME ZONE s.time_zone, 'YYYY-MM-DD'),
    'currency', (SELECT a.base_currency FROM accounting.settings a WHERE a.tenant_id = s.tenant_id),
    'services', coalesce((
      SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'description', v.description,
        'duration_minutes', v.duration_minutes, 'price', v.price, 'location_type', v.location_type,
        'capacity', v.capacity, 'questions', v.questions,
        'staff', coalesce((SELECT json_agg(json_build_object('id', st.id, 'name', st.display_name) ORDER BY st.display_name)
          FROM scheduler.staff st
          JOIN public.tenant_members tm ON tm.tenant_id = st.tenant_id AND tm.user_id = st.user_id
          WHERE st.tenant_id = s.tenant_id AND st.is_bookable
            AND (cardinality(v.staff_ids) = 0 OR st.user_id = ANY (v.staff_ids))
            AND EXISTS (SELECT 1 FROM scheduler.hours h WHERE h.tenant_id = st.tenant_id AND h.user_id = st.user_id)), '[]'::json))
        ORDER BY v.name)
      FROM scheduler.services v WHERE v.tenant_id = s.tenant_id AND v.is_active), '[]'::json))
  FROM scheduler.settings s JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.booking_key = p_key AND s.booking_enabled AND t.is_active IS NOT FALSE;
$$;

CREATE OR REPLACE FUNCTION public.booking_slots(p_key TEXT, p_service UUID, p_staff UUID, p_from DATE, p_days INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s scheduler.settings;
  person UUID;
BEGIN
  SELECT st.* INTO s FROM scheduler.settings st JOIN public.tenants t ON t.id = st.tenant_id
    WHERE st.booking_key = p_key AND st.booking_enabled AND t.is_active IS NOT FALSE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This booking page is not available';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scheduler.services WHERE id = p_service AND tenant_id = s.tenant_id AND is_active) THEN
    RAISE EXCEPTION 'Service not found';
  END IF;
  IF p_staff IS NOT NULL THEN
    SELECT user_id INTO person FROM scheduler.staff WHERE id = p_staff AND tenant_id = s.tenant_id;
    IF person IS NULL THEN
      RAISE EXCEPTION 'Person not found';
    END IF;
  END IF;
  IF p_from IS NULL OR p_days IS NULL OR p_days < 1 OR p_days > 14 THEN
    RAISE EXCEPTION 'Choose up to 14 days';
  END IF;
  RETURN scheduler.slots_json(s.tenant_id, p_service, person, p_from, p_from + p_days - 1, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.book_slot(p_key TEXT, p_service UUID, p_staff UUID, p_start TIMESTAMPTZ, p_visitor JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s scheduler.settings;
  person UUID;
  chosen UUID;
  booking UUID;
  local_day DATE;
  away TEXT;
  places INT;
  address TEXT := lower(btrim(coalesce(p_visitor->>'email', '')));
  camp TEXT := nullif(btrim(coalesce(p_visitor->>'campaign', '')), '');
BEGIN
  SELECT st.* INTO s FROM scheduler.settings st JOIN public.tenants t ON t.id = st.tenant_id
    WHERE st.booking_key = p_key AND st.booking_enabled AND t.is_active IS NOT FALSE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This booking page is not available';
  END IF;
  SELECT capacity INTO places FROM scheduler.services WHERE id = p_service AND tenant_id = s.tenant_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service not found';
  END IF;
  IF p_staff IS NOT NULL THEN
    SELECT user_id INTO person FROM scheduler.staff WHERE id = p_staff AND tenant_id = s.tenant_id;
    IF person IS NULL THEN
      RAISE EXCEPTION 'Person not found';
    END IF;
  END IF;
  IF p_start IS NULL THEN
    RAISE EXCEPTION 'Choose a time';
  END IF;
  IF address = '' THEN
    RAISE EXCEPTION 'Enter your email';
  END IF;
  IF length(coalesce(camp, '')) > 100 THEN
    RAISE EXCEPTION 'The campaign name is too long';
  END IF;

  -- A spam attack stops here instead of filling the calendar
  IF (SELECT count(*) FROM scheduler.bookings WHERE tenant_id = s.tenant_id AND source = 'public'
      AND created_at > now() - interval '1 day') >= 300 THEN
    RAISE EXCEPTION 'Booking is busy right now. Please try again later.';
  END IF;
  IF (SELECT count(*) FROM scheduler.bookings WHERE tenant_id = s.tenant_id AND status = 'booked'
      AND lower(customer_email) = address AND starts_at > now()) >= 5 THEN
    RAISE EXCEPTION 'You already have 5 upcoming bookings. Cancel one to book another.';
  END IF;

  -- A holiday, or the chosen person's leave, gets a plain reason instead of "no longer free"
  local_day := (p_start AT TIME ZONE s.time_zone)::date;
  away := scheduler.away_reason(s.tenant_id, person, local_day);
  IF away IS NOT NULL AND (person IS NOT NULL OR away LIKE 'The company is closed%') THEN
    RAISE EXCEPTION '%', away;
  END IF;

  -- The time must still be free. With anyone, a group session that already has people fills up
  -- first; otherwise the person with the fewest upcoming bookings gets it.
  SELECT x.slot_staff INTO chosen
    FROM scheduler.free_slots(s.tenant_id, p_service, person, local_day, local_day, true, NULL) x
    WHERE x.slot_start = p_start
    ORDER BY CASE WHEN places > 1 THEN scheduler.seats_taken(scheduler.session_key_of(p_service, x.slot_staff, x.slot_start), NULL) ELSE 0 END DESC,
      (SELECT count(*) FROM scheduler.bookings b WHERE b.staff_id = x.slot_staff AND b.status = 'booked' AND b.starts_at > now()),
      x.slot_staff
    LIMIT 1;
  IF chosen IS NULL THEN
    RAISE EXCEPTION 'That time is no longer free. Please pick another time.';
  END IF;

  booking := scheduler.place_booking(s.tenant_id, p_service, chosen, p_start,
    jsonb_build_object('name', p_visitor->>'name', 'email', address, 'phone', p_visitor->>'phone', 'notes', p_visitor->>'notes',
      'campaign', camp,
      'answers', CASE WHEN jsonb_typeof(p_visitor->'answers') = 'object' THEN p_visitor->'answers' ELSE '{}'::jsonb END),
    NULL, 'public');
  RETURN (scheduler.visitor_json(booking)::jsonb
    || jsonb_build_object('token', (SELECT token FROM scheduler.booking_tokens WHERE booking_id = booking)))::json;
END;
$$;

-- Free times a visitor can move their booking to: same service, same person
CREATE OR REPLACE FUNCTION public.booking_slots_by_token(p_token TEXT, p_from DATE, p_days INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
BEGIN
  SELECT bk.* INTO b FROM scheduler.booking_tokens k JOIN scheduler.bookings bk ON bk.id = k.booking_id
    WHERE coalesce(p_token, '') ~ '^[0-9a-f]{64}$' AND k.token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  IF NOT coalesce((scheduler.visitor_json(b.id)->>'can_reschedule')::boolean, false) THEN
    RAISE EXCEPTION 'This booking can''t be moved here. Please contact the company.';
  END IF;
  IF p_from IS NULL OR p_days IS NULL OR p_days < 1 OR p_days > 14 THEN
    RAISE EXCEPTION 'Choose up to 14 days';
  END IF;
  RETURN scheduler.slots_json(b.tenant_id, b.service_id, b.staff_id, p_from, p_from + p_days - 1, b.id);
END;
$$;

-- A visitor moves their own booking from their private link
CREATE OR REPLACE FUNCTION public.reschedule_booking_by_token(p_token TEXT, p_start TIMESTAMPTZ)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
  local_day DATE;
  away TEXT;
BEGIN
  SELECT bk.* INTO b FROM scheduler.booking_tokens k JOIN scheduler.bookings bk ON bk.id = k.booking_id
    WHERE coalesce(p_token, '') ~ '^[0-9a-f]{64}$' AND k.token = p_token
    FOR UPDATE OF bk;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'This booking is cancelled';
  END IF;
  IF b.starts_at <= now() THEN
    RAISE EXCEPTION 'This booking has already started, so it can''t be moved here';
  END IF;
  IF b.visitor_moves >= 3 THEN
    RAISE EXCEPTION 'This booking has already been moved 3 times. Please contact the company to change it.';
  END IF;
  IF NOT coalesce((scheduler.visitor_json(b.id)->>'can_reschedule')::boolean, false) THEN
    RAISE EXCEPTION 'Online changes are closed right now. Please contact the company.';
  END IF;
  IF p_start IS NULL THEN
    RAISE EXCEPTION 'Choose a time';
  END IF;
  IF p_start = b.starts_at THEN
    RETURN scheduler.visitor_json(b.id);
  END IF;
  local_day := (p_start AT TIME ZONE scheduler.tz(b.tenant_id))::date;
  away := scheduler.away_reason(b.tenant_id, b.staff_id, local_day);
  IF away IS NOT NULL THEN
    RAISE EXCEPTION '%', away;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scheduler.free_slots(b.tenant_id, b.service_id, b.staff_id, local_day, local_day, true, b.id) x
      WHERE x.slot_start = p_start) THEN
    RAISE EXCEPTION 'That time is no longer free. Please pick another time.';
  END IF;
  PERFORM scheduler.do_move(b.id, p_start, b.staff_id, true);
  UPDATE scheduler.bookings SET visitor_moves = visitor_moves + 1 WHERE id = b.id;
  RETURN scheduler.visitor_json(b.id);
END;
$$;

-- ---------------------------------------------------------------- Grants
-- Helpers used inside other functions, never called directly
REVOKE EXECUTE ON FUNCTION
  scheduler.session_key_of(UUID, UUID, TIMESTAMPTZ),
  scheduler.seats_taken(UUID, UUID),
  scheduler.clean_questions(JSONB),
  scheduler.clean_answers(JSONB, JSONB, BOOLEAN),
  scheduler.free_slots(UUID, UUID, UUID, DATE, DATE, BOOLEAN, UUID),
  scheduler.slots_json(UUID, UUID, UUID, DATE, DATE, UUID),
  scheduler.booking_json(UUID),
  scheduler.visitor_json(UUID),
  scheduler.place_booking(UUID, UUID, UUID, TIMESTAMPTZ, JSONB, UUID, TEXT),
  scheduler.do_cancel(UUID, TEXT, BOOLEAN),
  scheduler.do_move(UUID, TIMESTAMPTZ, UUID, BOOLEAN),
  scheduler.ics_text(TEXT),
  scheduler.ics_fold(TEXT),
  scheduler.ics_utc(TIMESTAMPTZ),
  scheduler.ics_event(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TIMESTAMPTZ),
  scheduler.ics_calendar(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

-- Signed-in team members (each function checks the person's role itself)
REVOKE EXECUTE ON FUNCTION
  scheduler.free_times(UUID, UUID, UUID, DATE, UUID),
  scheduler.reschedule_booking(UUID, UUID, JSONB),
  scheduler.save_service(UUID, UUID, JSONB),
  scheduler.create_repeat_bookings(UUID, JSONB),
  scheduler.cancel_repeats(UUID, UUID, TEXT),
  scheduler.mark_attendance(UUID, UUID, TEXT),
  scheduler.mark_reminded(UUID, UUID, BOOLEAN),
  scheduler.follow_up(UUID, UUID),
  scheduler.stats(UUID, DATE, DATE),
  scheduler.feed_link(UUID),
  scheduler.new_feed_link(UUID),
  scheduler.stop_feed_link(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  scheduler.free_times(UUID, UUID, UUID, DATE, UUID),
  scheduler.reschedule_booking(UUID, UUID, JSONB),
  scheduler.save_service(UUID, UUID, JSONB),
  scheduler.create_repeat_bookings(UUID, JSONB),
  scheduler.cancel_repeats(UUID, UUID, TEXT),
  scheduler.mark_attendance(UUID, UUID, TEXT),
  scheduler.mark_reminded(UUID, UUID, BOOLEAN),
  scheduler.follow_up(UUID, UUID),
  scheduler.stats(UUID, DATE, DATE),
  scheduler.feed_link(UUID),
  scheduler.new_feed_link(UUID),
  scheduler.stop_feed_link(UUID)
  TO authenticated;

-- The public booking pages and calendar links, for visitors and calendar apps that are not signed in
REVOKE EXECUTE ON FUNCTION
  public.booking_page(TEXT),
  public.booking_slots(TEXT, UUID, UUID, DATE, INT),
  public.book_slot(TEXT, UUID, UUID, TIMESTAMPTZ, JSONB),
  public.booking_ics(TEXT),
  public.staff_feed_ics(TEXT),
  public.booking_slots_by_token(TEXT, DATE, INT),
  public.reschedule_booking_by_token(TEXT, TIMESTAMPTZ)
  FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION
  public.booking_page(TEXT),
  public.booking_slots(TEXT, UUID, UUID, DATE, INT),
  public.book_slot(TEXT, UUID, UUID, TIMESTAMPTZ, JSONB),
  public.booking_ics(TEXT),
  public.staff_feed_ics(TEXT),
  public.booking_slots_by_token(TEXT, DATE, INT),
  public.reschedule_booking_by_token(TEXT, TIMESTAMPTZ)
  TO anon;

NOTIFY pgrst, 'reload schema';
