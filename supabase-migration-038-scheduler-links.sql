-- Scheduler links to HR, Accounting and campaigns.
-- 1. People on approved HR leave, and company holidays from HR, can't be booked. Free times skip
--    those days. The public page always refuses them; staff typing a time (which may already go
--    outside opening hours) get a clear warning and must confirm to book anyway.
-- 2. A booking for a paid service makes a DRAFT invoice for the CRM contact's Accounting customer
--    (never posted or sent automatically). Cancelling deletes the draft; a sent invoice is kept and noted.
--    Companies can turn this off in Scheduler settings.
-- 3. The public booking page sends the campaign from its link; it is kept on the booking and on a
--    newly made CRM contact.

ALTER TABLE scheduler.settings ADD COLUMN IF NOT EXISTS draft_invoices BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE scheduler.bookings
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES accounting.invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invoice_note TEXT CHECK (length(invoice_note) <= 300),
  ADD COLUMN IF NOT EXISTS campaign TEXT CHECK (length(campaign) <= 100);
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_invoice ON scheduler.bookings (invoice_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_campaign ON scheduler.bookings (tenant_id, lower(campaign)) WHERE campaign IS NOT NULL;

-- Why someone can't be booked on a day (in the company's time zone), or NULL when they can.
-- A half-day leave blocks the whole day: HR doesn't record which half, so this is the safe choice.
CREATE OR REPLACE FUNCTION scheduler.away_reason(p_tenant UUID, p_user UUID, p_day DATE)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT 'The company is closed that day (' || h.name || ')' FROM hr.holidays h
      WHERE h.tenant_id = p_tenant AND h.holiday_date = p_day LIMIT 1),
    (SELECT 'That person is away on leave that day' FROM hr.leave_requests l
      JOIN hr.employees e ON e.id = l.employee_id
      WHERE l.tenant_id = p_tenant AND e.tenant_id = p_tenant AND e.user_id = p_user
        AND l.status = 'approved' AND p_day BETWEEN l.start_date AND l.end_date LIMIT 1));
$$;

-- The first reason any day of a booking is blocked
CREATE OR REPLACE FUNCTION scheduler.away_during(p_tenant UUID, p_user UUID, p_start TIMESTAMPTZ, p_end TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT scheduler.away_reason(p_tenant, p_user, d::date)
  FROM generate_series((p_start AT TIME ZONE scheduler.tz(p_tenant))::date::timestamp,
    ((p_end - interval '1 second') AT TIME ZONE scheduler.tz(p_tenant))::date::timestamp, interval '1 day') d
  WHERE scheduler.away_reason(p_tenant, p_user, d::date) IS NOT NULL
  ORDER BY d LIMIT 1;
$$;

-- Matches a CRM contact by email, or adds one (with the campaign that brought them, if any)
CREATE OR REPLACE FUNCTION scheduler.find_contact(p_tenant UUID, p_name TEXT, p_email TEXT, p_phone TEXT, p_owner UUID, p_campaign TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found UUID;
BEGIN
  IF coalesce(p_email, '') = '' THEN
    RETURN NULL;
  END IF;
  SELECT id INTO found FROM crm.contacts
    WHERE tenant_id = p_tenant AND lower(email) = lower(p_email) ORDER BY created_at LIMIT 1;
  IF found IS NOT NULL THEN
    RETURN found;
  END IF;
  PERFORM set_config('crm.trusted', 'on', true);
  INSERT INTO crm.contacts (tenant_id, name, email, phone, owner_id, source, campaign)
    VALUES (p_tenant, p_name, lower(p_email), nullif(p_phone, ''), p_owner, 'Booking', nullif(btrim(coalesce(p_campaign, '')), ''))
    RETURNING id INTO found;
  PERFORM set_config('crm.trusted', '', true);
  RETURN found;
END;
$$;

CREATE OR REPLACE FUNCTION scheduler.find_contact(p_tenant UUID, p_name TEXT, p_email TEXT, p_phone TEXT, p_owner UUID)
RETURNS UUID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  SELECT scheduler.find_contact(p_tenant, p_name, p_email, p_phone, p_owner, NULL);
$$;

-- A draft invoice for a paid booking, for the contact's Accounting customer (found or made the
-- same way CRM quotes do it), in the company's base currency. Never posted or sent here.
CREATE OR REPLACE FUNCTION scheduler.draft_invoice(p_booking UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
  svc scheduler.services;
  q crm.quotes;
  zone TEXT;
  local_day DATE;
  next_number BIGINT;
  invoice accounting.invoices;
BEGIN
  SELECT * INTO b FROM scheduler.bookings WHERE id = p_booking;
  SELECT * INTO svc FROM scheduler.services WHERE id = b.service_id;
  zone := scheduler.tz(b.tenant_id);
  local_day := (b.starts_at AT TIME ZONE zone)::date;
  q.tenant_id := b.tenant_id;
  q.contact_id := b.contact_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(b.tenant_id::text, 7));
  SELECT coalesce(max(substring(i.invoice_number FROM '^INV-(\d+)$')::bigint), 0) + 1 INTO next_number
    FROM accounting.invoices i WHERE i.tenant_id = b.tenant_id;

  INSERT INTO accounting.invoices (tenant_id, invoice_number, customer_id, due_date, amount, currency, line_items, description)
    VALUES (b.tenant_id, 'INV-' || lpad(next_number::text, 4, '0'), crm.customer_for_quote(q),
      greatest(current_date, local_day), 0, accounting.base_currency(b.tenant_id),
      jsonb_build_array(jsonb_build_object('description', left(svc.name || ' on ' || to_char(local_day, 'DD Mon YYYY'), 500),
        'quantity', 1, 'unit_price', svc.price)),
      left('From booking: ' || svc.name || ' with ' || b.customer_name, 500))
    RETURNING * INTO invoice;

  UPDATE scheduler.bookings SET invoice_id = invoice.id, invoice_note = NULL WHERE id = b.id;
  INSERT INTO crm.activities (tenant_id, kind, subject, contact_id, owner_id)
    VALUES (b.tenant_id, 'note', left('Invoice ' || invoice.invoice_number || ' drafted for ' || svc.name || ' on '
      || to_char(local_day, 'DD Mon YYYY'), 300), b.contact_id, scheduler.current_member(b.tenant_id, b.staff_id));
  RETURN invoice.id;
END;
$$;

-- Free start times. Hours and days off are in the company's time zone. A start is free when the
-- whole service plus its buffer fits in the person's hours and touches no other booking or meeting.
-- Company holidays (HR) and the person's approved leave (HR) close the whole day; a half day
-- of leave closes the whole day too.
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
    SELECT w.user_id, g AS slot
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
          && tstzrange(c.slot, c.slot + (svc.duration_minutes + svc.buffer_minutes) * interval '1 minute'))
    AND NOT EXISTS (
      SELECT 1 FROM scheduler.meetings m
      WHERE m.tenant_id = p_tenant AND m.host_id = c.user_id AND m.status = 'scheduled'
        AND NOT EXISTS (SELECT 1 FROM scheduler.bookings b2 WHERE b2.meeting_id = m.id)
        AND tstzrange(m.starts_at, m.starts_at + m.duration_minutes * interval '1 minute')
          && tstzrange(c.slot, c.slot + svc.duration_minutes * interval '1 minute'))
  ORDER BY c.slot, c.user_id;
END;
$$;

CREATE OR REPLACE FUNCTION scheduler.booking_json(p_booking UUID)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
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
    'invoice_note', b.invoice_note, 'campaign', b.campaign)
  FROM scheduler.bookings b
  JOIN scheduler.services v ON v.id = b.service_id
  CROSS JOIN LATERAL (SELECT scheduler.tz(b.tenant_id) AS zone) z
  LEFT JOIN scheduler.staff st ON st.tenant_id = b.tenant_id AND st.user_id = b.staff_id
  LEFT JOIN scheduler.meetings m ON m.id = b.meeting_id
  LEFT JOIN accounting.invoices i ON i.id = b.invoice_id
  WHERE b.id = p_booking;
$$;

-- Every booking, from staff or the public page, goes through here.
-- p_customer may hold 'override_away' (staff only, after a warning) and 'campaign' (public only).
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

  ends := p_start + svc.duration_minutes * interval '1 minute';

  -- Leave and holidays. Staff can book anyway after a warning, the same way typed times may go
  -- outside opening hours; the public page never can.
  away := scheduler.away_during(p_tenant, p_staff, p_start, ends);
  IF away IS NOT NULL AND NOT (p_source = 'staff' AND coalesce(p_customer->>'override_away', '') = 'true') THEN
    RAISE EXCEPTION '%', away;
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
    INSERT INTO scheduler.meetings (tenant_id, title, starts_at, duration_minutes, room_url, host_id, created_by)
      VALUES (p_tenant, left(svc.name || ' with ' || who, 200), p_start, svc.duration_minutes,
        scheduler.room_url(p_tenant), p_staff, auth.uid())
      RETURNING id INTO meeting;
    IF contact IS NOT NULL THEN
      INSERT INTO scheduler.meeting_contacts (meeting_id, contact_id, tenant_id) VALUES (meeting, contact, p_tenant);
    END IF;
  END IF;

  BEGIN
    INSERT INTO scheduler.bookings (tenant_id, service_id, staff_id, starts_at, ends_at, blocked_until,
      customer_name, customer_email, customer_phone, notes, location_type, location_detail, contact_id,
      meeting_id, source, created_by, campaign)
    VALUES (p_tenant, svc.id, p_staff, p_start, ends, ends + svc.buffer_minutes * interval '1 minute',
      who, nullif(address, ''), nullif(phone_number, ''), note, svc.location_type, svc.location_detail, contact,
      meeting, p_source, auth.uid(), camp)
    RETURNING id INTO booking;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time is already booked. Please pick another time.';
  END;

  INSERT INTO scheduler.booking_tokens (booking_id, token) VALUES (booking, encode(extensions.gen_random_bytes(32), 'hex'));

  IF contact IS NOT NULL THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, body, contact_id, owner_id)
      VALUES (p_tenant, 'meeting', left(svc.name || ' on ' || said_when, 300),
        concat_ws(E'\n',
          CASE WHEN p_source = 'public' THEN 'Booked online with ' ELSE 'Booked by the team with ' END || staff_name,
          CASE svc.location_type WHEN 'video' THEN 'Video call' WHEN 'phone' THEN 'Phone call' ELSE 'In person' END
            || coalesce(': ' || svc.location_detail, ''),
          note),
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

  PERFORM scheduler.notify(p_tenant, p_staff, 'New booking: ' || who, svc.name || ', ' || said_when,
    '/saas/scheduler?date=' || to_char(p_start AT TIME ZONE zone, 'YYYY-MM-DD'), 'booking:' || booking || ':booked');
  RETURN booking;
END;
$$;

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
  UPDATE scheduler.meetings SET status = 'cancelled' WHERE id = b.meeting_id;

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

CREATE OR REPLACE FUNCTION scheduler.save_settings(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  zone TEXT := coalesce(nullif(btrim(p_data->>'time_zone'), ''), 'UTC');
  s scheduler.settings;
BEGIN
  PERFORM scheduler.require_manager(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = zone) THEN
    RAISE EXCEPTION 'Choose a time zone from the list';
  END IF;
  IF length(coalesce(p_data->>'welcome', '')) > 1000 THEN
    RAISE EXCEPTION 'The welcome message is too long';
  END IF;
  PERFORM scheduler.ensure_settings(p_tenant);
  UPDATE scheduler.settings SET
    time_zone = zone,
    booking_enabled = coalesce((p_data->>'booking_enabled')::boolean, booking_enabled),
    min_notice_minutes = scheduler.int_of(p_data->>'min_notice_minutes', 0, 43200, 'Minimum notice must be between 0 minutes and 30 days'),
    max_days_ahead = scheduler.int_of(p_data->>'max_days_ahead', 1, 365, 'Days ahead must be between 1 and 365'),
    slot_step_minutes = scheduler.int_of(p_data->>'slot_step_minutes', 5, 120, 'Choose how often start times are offered'),
    welcome = nullif(btrim(coalesce(p_data->>'welcome', '')), ''),
    draft_invoices = coalesce((p_data->>'draft_invoices')::boolean, draft_invoices),
    updated_at = now()
  WHERE tenant_id = p_tenant
  RETURNING * INTO s;
  RETURN row_to_json(s);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'Choose how often start times are offered';
END;
$$;

CREATE OR REPLACE FUNCTION scheduler.create_booking(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  booking UUID;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  booking := scheduler.place_booking(p_tenant, (p_data->>'service_id')::uuid, (p_data->>'staff_id')::uuid,
    scheduler.local_start(scheduler.tz(p_tenant), p_data->>'date', p_data->>'time'),
    p_data - 'campaign', nullif(p_data->>'contact_id', '')::uuid, 'staff');
  RETURN scheduler.booking_json(booking);
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
  svc_name TEXT;
  said_when TEXT;
  day_link TEXT;
  away TEXT;
  new_day DATE;
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

  BEGIN
    UPDATE scheduler.bookings SET
      starts_at = new_start,
      ends_at = new_start + (b.ends_at - b.starts_at),
      blocked_until = new_start + (b.blocked_until - b.starts_at),
      staff_id = new_staff,
      updated_at = now()
    WHERE id = b.id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time is already booked. Please pick another time.';
  END;
  UPDATE scheduler.meetings SET starts_at = new_start, host_id = new_staff WHERE id = b.meeting_id;

  SELECT name INTO svc_name FROM scheduler.services WHERE id = b.service_id;
  new_day := (new_start AT TIME ZONE zone)::date;
  IF b.invoice_id IS NOT NULL THEN
    BEGIN
      UPDATE accounting.invoices SET
        line_items = jsonb_set(line_items, '{0,description}',
          to_jsonb(left(svc_name || ' on ' || to_char(new_day, 'DD Mon YYYY'), 500))),
        due_date = greatest(current_date, new_day), updated_at = now()
      WHERE id = b.invoice_id AND status = 'draft' AND jsonb_array_length(line_items) = 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- The invoice was changed in Accounting; leave it as it is
    END;
  END IF;

  said_when := scheduler.when_text(new_start, zone);
  day_link := '/saas/scheduler?date=' || to_char(new_start AT TIME ZONE zone, 'YYYY-MM-DD');
  IF b.contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm.contacts WHERE id = b.contact_id) THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, body, contact_id, owner_id)
      VALUES (p_tenant, 'meeting', left('Moved: ' || svc_name || ' to ' || said_when, 300),
        'Was ' || scheduler.when_text(b.starts_at, zone), b.contact_id, new_staff);
  END IF;
  PERFORM scheduler.notify(p_tenant, new_staff, 'Booking moved: ' || b.customer_name, svc_name || ', now ' || said_when,
    day_link, 'booking:' || b.id || ':moved:' || extract(epoch FROM new_start)::bigint || ':' || new_staff);
  IF b.staff_id IS DISTINCT FROM new_staff THEN
    PERFORM scheduler.notify(p_tenant, b.staff_id, 'Booking handed over: ' || b.customer_name,
      svc_name || ' on ' || scheduler.when_text(b.starts_at, zone) || ' is now with someone else', day_link,
      'booking:' || b.id || ':handover:' || extract(epoch FROM new_start)::bigint);
  END IF;
  RETURN scheduler.booking_json(b.id);
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
  address TEXT := lower(btrim(coalesce(p_visitor->>'email', '')));
  camp TEXT := nullif(btrim(coalesce(p_visitor->>'campaign', '')), '');
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

  -- The time must still be free. With anyone, the person with the fewest upcoming bookings gets it.
  SELECT x.slot_staff INTO chosen
    FROM scheduler.free_slots(s.tenant_id, p_service, person, local_day, local_day, true, NULL) x
    WHERE x.slot_start = p_start
    ORDER BY (SELECT count(*) FROM scheduler.bookings b WHERE b.staff_id = x.slot_staff AND b.status = 'booked' AND b.starts_at > now()),
      x.slot_staff
    LIMIT 1;
  IF chosen IS NULL THEN
    RAISE EXCEPTION 'That time is no longer free. Please pick another time.';
  END IF;

  booking := scheduler.place_booking(s.tenant_id, p_service, chosen, p_start,
    jsonb_build_object('name', p_visitor->>'name', 'email', address, 'phone', p_visitor->>'phone', 'notes', p_visitor->>'notes',
      'campaign', camp),
    NULL, 'public');
  RETURN (scheduler.visitor_json(booking)::jsonb
    || jsonb_build_object('token', (SELECT token FROM scheduler.booking_tokens WHERE booking_id = booking)))::json;
END;
$$;

-- Grants: helpers stay closed; the rest keep what they had
REVOKE EXECUTE ON FUNCTION
  scheduler.away_reason(UUID, UUID, DATE),
  scheduler.away_during(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ),
  scheduler.find_contact(UUID, TEXT, TEXT, TEXT, UUID, TEXT),
  scheduler.find_contact(UUID, TEXT, TEXT, TEXT, UUID),
  scheduler.draft_invoice(UUID),
  scheduler.free_slots(UUID, UUID, UUID, DATE, DATE, BOOLEAN, UUID),
  scheduler.booking_json(UUID),
  scheduler.place_booking(UUID, UUID, UUID, TIMESTAMPTZ, JSONB, UUID, TEXT),
  scheduler.do_cancel(UUID, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  scheduler.save_settings(UUID, JSONB),
  scheduler.create_booking(UUID, JSONB),
  scheduler.reschedule_booking(UUID, UUID, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  scheduler.save_settings(UUID, JSONB),
  scheduler.create_booking(UUID, JSONB),
  scheduler.reschedule_booking(UUID, UUID, JSONB)
  TO authenticated;

REVOKE EXECUTE ON FUNCTION public.book_slot(TEXT, UUID, UUID, TIMESTAMPTZ, JSONB) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.book_slot(TEXT, UUID, UUID, TIMESTAMPTZ, JSONB) TO anon;

NOTIFY pgrst, 'reload schema';
