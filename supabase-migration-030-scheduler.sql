-- Scheduler and video meetings. Companies list the services people can book, each team member
-- sets weekly hours and days off, and bookings come from staff or from a public booking page.
-- Nobody can be double booked: the database refuses overlapping bookings for the same person.
-- Video meetings run on Jitsi Meet (free, no account or key); video bookings get a room link.
-- Every public booking matches or creates a CRM contact and logs a meeting on their timeline.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS scheduler;
GRANT USAGE ON SCHEMA scheduler TO authenticated, service_role;

-- Role checks
CREATE FUNCTION scheduler.role_of(p_tenant UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid();
$$;

CREATE FUNCTION scheduler.is_member(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT scheduler.role_of(p_tenant) IS NOT NULL;
$$;

CREATE FUNCTION scheduler.is_manager(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(scheduler.role_of(p_tenant) IN ('owner', 'admin'), false);
$$;

-- Everyone but viewers can book, move and cancel
CREATE FUNCTION scheduler.require_staff(p_tenant UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r TEXT := scheduler.role_of(p_tenant);
BEGIN
  IF r IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF r = 'viewer' THEN
    RAISE EXCEPTION 'Viewers can look but not make changes';
  END IF;
  RETURN r;
END;
$$;

CREATE FUNCTION scheduler.require_manager(p_tenant UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF scheduler.role_of(p_tenant) IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF NOT scheduler.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'Only owners and admins can do that';
  END IF;
END;
$$;

-- Company settings. The booking key makes the private public-page link.
CREATE TABLE scheduler.settings (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  time_zone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64),
  booking_key TEXT NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(16), 'hex'),
  booking_enabled BOOLEAN NOT NULL DEFAULT true,
  min_notice_minutes INT NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 43200),
  max_days_ahead INT NOT NULL DEFAULT 60 CHECK (max_days_ahead BETWEEN 1 AND 365),
  slot_step_minutes INT NOT NULL DEFAULT 30 CHECK (slot_step_minutes IN (5, 10, 15, 20, 30, 45, 60, 90, 120)),
  welcome TEXT CHECK (length(welcome) <= 1000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE scheduler.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON scheduler.settings FOR SELECT TO authenticated USING (scheduler.is_member(tenant_id));
GRANT SELECT ON scheduler.settings TO authenticated;

-- Team members who take bookings. The id is what the public page shows instead of the user id.
CREATE TABLE scheduler.staff (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  is_bookable BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX idx_scheduler_staff_user ON scheduler.staff (user_id);
ALTER TABLE scheduler.staff ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON scheduler.staff FOR SELECT TO authenticated USING (scheduler.is_member(tenant_id));
GRANT SELECT ON scheduler.staff TO authenticated;

-- Weekly opening hours, in the company's time zone. Weekday 0 is Sunday. A day can have several blocks.
CREATE TABLE scheduler.hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CHECK (end_time > start_time),
  FOREIGN KEY (tenant_id, user_id) REFERENCES scheduler.staff (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_scheduler_hours_staff ON scheduler.hours (tenant_id, user_id, weekday);
ALTER TABLE scheduler.hours ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON scheduler.hours FOR SELECT TO authenticated USING (scheduler.is_member(tenant_id));
GRANT SELECT ON scheduler.hours TO authenticated;

-- Days off for one person, or for the whole company when there is no person
CREATE TABLE scheduler.days_off (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID,
  off_date DATE NOT NULL,
  note TEXT CHECK (length(note) <= 200),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES scheduler.staff (tenant_id, user_id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, off_date)
);
CREATE INDEX idx_scheduler_days_off_date ON scheduler.days_off (tenant_id, off_date);
CREATE INDEX idx_scheduler_days_off_created_by ON scheduler.days_off (created_by);
ALTER TABLE scheduler.days_off ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON scheduler.days_off FOR SELECT TO authenticated USING (scheduler.is_member(tenant_id));
GRANT SELECT ON scheduler.days_off TO authenticated;

-- What people can book. No staff listed means anyone who takes bookings.
CREATE TABLE scheduler.services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description TEXT CHECK (length(description) <= 1000),
  duration_minutes INT NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  buffer_minutes INT NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  price NUMERIC(12,2) CHECK (price >= 0),
  location_type TEXT NOT NULL DEFAULT 'in_person' CHECK (location_type IN ('in_person', 'phone', 'video')),
  location_detail TEXT CHECK (length(location_detail) <= 300),
  staff_ids UUID[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_scheduler_services_name ON scheduler.services (tenant_id, lower(name));
ALTER TABLE scheduler.services ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON scheduler.services FOR SELECT TO authenticated USING (scheduler.is_member(tenant_id));
GRANT SELECT ON scheduler.services TO authenticated;

-- Video meetings on Jitsi Meet
CREATE TABLE scheduler.meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  starts_at TIMESTAMPTZ NOT NULL,
  duration_minutes INT NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 720),
  room_url TEXT NOT NULL UNIQUE CHECK (room_url LIKE 'https://meet.jit.si/%'),
  host_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT CHECK (length(notes) <= 2000),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_scheduler_meetings_time ON scheduler.meetings (tenant_id, starts_at);
CREATE INDEX idx_scheduler_meetings_host ON scheduler.meetings (host_id, starts_at);
CREATE INDEX idx_scheduler_meetings_created_by ON scheduler.meetings (created_by);
ALTER TABLE scheduler.meetings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON scheduler.meetings FOR SELECT TO authenticated USING (scheduler.is_member(tenant_id));
GRANT SELECT ON scheduler.meetings TO authenticated;

CREATE TABLE scheduler.meeting_contacts (
  meeting_id UUID NOT NULL REFERENCES scheduler.meetings(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES crm.contacts(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, contact_id)
);
CREATE INDEX idx_scheduler_meeting_contacts_contact ON scheduler.meeting_contacts (contact_id);
CREATE INDEX idx_scheduler_meeting_contacts_tenant ON scheduler.meeting_contacts (tenant_id);
ALTER TABLE scheduler.meeting_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON scheduler.meeting_contacts FOR SELECT TO authenticated USING (scheduler.is_member(tenant_id));
GRANT SELECT ON scheduler.meeting_contacts TO authenticated;

-- Bookings. The time a person is busy runs from the start to the end plus the service's buffer,
-- and two live bookings for the same person can never overlap.
CREATE TABLE scheduler.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES scheduler.services(id),
  staff_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  blocked_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  customer_name TEXT NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 200),
  customer_email TEXT CHECK (length(customer_email) <= 254),
  customer_phone TEXT CHECK (length(customer_phone) <= 40),
  notes TEXT CHECK (length(notes) <= 2000),
  location_type TEXT NOT NULL CHECK (location_type IN ('in_person', 'phone', 'video')),
  location_detail TEXT CHECK (length(location_detail) <= 300),
  contact_id UUID REFERENCES crm.contacts(id) ON DELETE SET NULL,
  activity_id UUID REFERENCES crm.activities(id) ON DELETE SET NULL,
  meeting_id UUID REFERENCES scheduler.meetings(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('staff', 'public')),
  cancelled_at TIMESTAMPTZ,
  cancelled_by_visitor BOOLEAN NOT NULL DEFAULT false,
  cancel_reason TEXT CHECK (length(cancel_reason) <= 500),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (blocked_until >= ends_at),
  CONSTRAINT no_double_booking EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, blocked_until) WITH &&)
    WHERE (status = 'booked')
);
CREATE INDEX idx_scheduler_bookings_time ON scheduler.bookings (tenant_id, starts_at);
CREATE INDEX idx_scheduler_bookings_staff ON scheduler.bookings (staff_id, starts_at);
CREATE INDEX idx_scheduler_bookings_service ON scheduler.bookings (service_id);
CREATE INDEX idx_scheduler_bookings_contact ON scheduler.bookings (contact_id);
CREATE INDEX idx_scheduler_bookings_activity ON scheduler.bookings (activity_id);
CREATE INDEX idx_scheduler_bookings_meeting ON scheduler.bookings (meeting_id);
CREATE INDEX idx_scheduler_bookings_created_by ON scheduler.bookings (created_by);
CREATE INDEX idx_scheduler_bookings_email ON scheduler.bookings (tenant_id, lower(customer_email));
ALTER TABLE scheduler.bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON scheduler.bookings FOR SELECT TO authenticated USING (scheduler.is_member(tenant_id));
GRANT SELECT ON scheduler.bookings TO authenticated;

-- The secret in each visitor's cancel link. Nobody can read this table directly.
CREATE TABLE scheduler.booking_tokens (
  booking_id UUID PRIMARY KEY REFERENCES scheduler.bookings(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE
);
ALTER TABLE scheduler.booking_tokens ENABLE ROW LEVEL SECURITY;

-- Helpers
CREATE FUNCTION scheduler.ensure_settings(p_tenant UUID)
RETURNS scheduler.settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s scheduler.settings;
BEGIN
  INSERT INTO scheduler.settings (tenant_id) VALUES (p_tenant) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO s FROM scheduler.settings WHERE tenant_id = p_tenant;
  RETURN s;
END;
$$;

CREATE FUNCTION scheduler.tz(p_tenant UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT time_zone FROM scheduler.settings WHERE tenant_id = p_tenant), 'UTC');
$$;

CREATE FUNCTION scheduler.when_text(p_at TIMESTAMPTZ, p_tz TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT to_char(p_at AT TIME ZONE p_tz, 'Dy DD Mon YYYY "at" HH24:MI') || ' (' || p_tz || ')';
$$;

-- A date and time typed in the company's time zone
CREATE FUNCTION scheduler.local_start(p_tz TEXT, p_date TEXT, p_time TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  IF coalesce(p_date, '') !~ '^\d{4}-\d{2}-\d{2}$' OR coalesce(p_time, '') !~ '^\d{2}:\d{2}$' THEN
    RAISE EXCEPTION 'Choose a date and time';
  END IF;
  RETURN (p_date::date + p_time::time) AT TIME ZONE p_tz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'Choose a date and time';
END;
$$;

CREATE FUNCTION scheduler.int_of(p_value TEXT, p_min INT, p_max INT, p_message TEXT)
RETURNS INT
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
  IF coalesce(p_value, '') !~ '^\d{1,6}$' THEN
    RAISE EXCEPTION '%', p_message;
  END IF;
  IF p_value::int < p_min OR p_value::int > p_max THEN
    RAISE EXCEPTION '%', p_message;
  END IF;
  RETURN p_value::int;
END;
$$;

-- https://meet.jit.si/<company-name>-<random id>. The random part keeps strangers out of the room.
CREATE FUNCTION scheduler.room_url(p_tenant UUID)
RETURNS TEXT
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT 'https://meet.jit.si/'
    || coalesce(nullif(left(btrim(regexp_replace(lower(t.name), '[^a-z0-9]+', '-', 'g'), '-'), 40), ''), 'meeting')
    || '-' || encode(extensions.gen_random_bytes(12), 'hex')
  FROM public.tenants t WHERE t.id = p_tenant;
$$;

-- Matches a CRM contact by email, or adds one. Required custom fields can't block a booking.
CREATE FUNCTION scheduler.find_contact(p_tenant UUID, p_name TEXT, p_email TEXT, p_phone TEXT, p_owner UUID)
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
  INSERT INTO crm.contacts (tenant_id, name, email, phone, owner_id, source)
    VALUES (p_tenant, p_name, lower(p_email), nullif(p_phone, ''), p_owner, 'Booking')
    RETURNING id INTO found;
  PERFORM set_config('crm.trusted', '', true);
  RETURN found;
END;
$$;

-- An alert in the bell, unless the person did it themself
CREATE FUNCTION scheduler.notify(p_tenant UUID, p_user UUID, p_title TEXT, p_body TEXT, p_link TEXT, p_key TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
  SELECT p_tenant, p_user, left(p_title, 200), p_body, p_link, p_key
  FROM public.tenant_members tm
  WHERE tm.tenant_id = p_tenant AND tm.user_id = p_user AND p_user IS DISTINCT FROM auth.uid()
  ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
$$;

-- The person, if they are still on the team (old records keep them, new CRM entries can't)
CREATE FUNCTION scheduler.current_member(p_tenant UUID, p_user UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT user_id FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = p_user;
$$;

-- Free start times. Hours and days off are in the company's time zone. A start is free when the
-- whole service plus its buffer fits in the person's hours and touches no other booking or meeting.
CREATE FUNCTION scheduler.free_slots(p_tenant UUID, p_service UUID, p_staff UUID, p_from DATE, p_to DATE,
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

CREATE FUNCTION scheduler.booking_json(p_booking UUID)
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
    'created_at', b.created_at)
  FROM scheduler.bookings b
  JOIN scheduler.services v ON v.id = b.service_id
  CROSS JOIN LATERAL (SELECT scheduler.tz(b.tenant_id) AS zone) z
  LEFT JOIN scheduler.staff st ON st.tenant_id = b.tenant_id AND st.user_id = b.staff_id
  LEFT JOIN scheduler.meetings m ON m.id = b.meeting_id
  WHERE b.id = p_booking;
$$;

CREATE FUNCTION scheduler.meeting_json(p_meeting UUID)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'id', m.id, 'title', m.title, 'starts_at', m.starts_at, 'duration_minutes', m.duration_minutes,
    'ends_at', m.starts_at + m.duration_minutes * interval '1 minute',
    'local_date', to_char(m.starts_at AT TIME ZONE z.zone, 'YYYY-MM-DD'),
    'start_time', to_char(m.starts_at AT TIME ZONE z.zone, 'HH24:MI'),
    'room_url', m.room_url, 'status', m.status, 'notes', m.notes, 'host_id', m.host_id,
    'host_name', coalesce(st.display_name, split_part(u.email, '@', 1)),
    'booking_id', (SELECT b.id FROM scheduler.bookings b WHERE b.meeting_id = m.id LIMIT 1),
    'is_live', m.status = 'scheduled' AND now() >= m.starts_at - interval '10 minutes'
      AND now() < m.starts_at + m.duration_minutes * interval '1 minute',
    'contacts', coalesce((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'email', c.email) ORDER BY c.name)
      FROM scheduler.meeting_contacts mc JOIN crm.contacts c ON c.id = mc.contact_id WHERE mc.meeting_id = m.id), '[]'::json))
  FROM scheduler.meetings m
  CROSS JOIN LATERAL (SELECT scheduler.tz(m.tenant_id) AS zone) z
  LEFT JOIN scheduler.staff st ON st.tenant_id = m.tenant_id AND st.user_id = m.host_id
  LEFT JOIN auth.users u ON u.id = m.host_id
  WHERE m.id = p_meeting;
$$;

-- What a visitor sees about their own booking
CREATE FUNCTION scheduler.visitor_json(p_booking UUID)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'company', t.name, 'service', v.name, 'with', coalesce(st.display_name, t.name),
    'when', scheduler.when_text(b.starts_at, z.zone), 'starts_at', b.starts_at,
    'local_date', to_char(b.starts_at AT TIME ZONE z.zone, 'YYYY-MM-DD'),
    'start_time', to_char(b.starts_at AT TIME ZONE z.zone, 'HH24:MI'),
    'end_time', to_char(b.ends_at AT TIME ZONE z.zone, 'HH24:MI'),
    'time_zone', z.zone, 'location_type', b.location_type, 'location_detail', b.location_detail,
    'room_url', CASE WHEN b.status = 'booked' THEN m.room_url END,
    'status', b.status, 'can_cancel', b.status = 'booked' AND b.starts_at > now(), 'name', b.customer_name)
  FROM scheduler.bookings b
  JOIN public.tenants t ON t.id = b.tenant_id
  JOIN scheduler.services v ON v.id = b.service_id
  CROSS JOIN LATERAL (SELECT scheduler.tz(b.tenant_id) AS zone) z
  LEFT JOIN scheduler.staff st ON st.tenant_id = b.tenant_id AND st.user_id = b.staff_id
  LEFT JOIN scheduler.meetings m ON m.id = b.meeting_id
  WHERE b.id = p_booking;
$$;

-- Every booking, from staff or the public page, goes through here
CREATE FUNCTION scheduler.place_booking(p_tenant UUID, p_service UUID, p_staff UUID, p_start TIMESTAMPTZ,
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
  contact UUID := p_contact;
  staff_name TEXT;
  meeting UUID;
  booking UUID;
  activity UUID;
  ends TIMESTAMPTZ;
  said_when TEXT;
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
  IF svc.location_type = 'phone' AND phone_number = '' THEN
    RAISE EXCEPTION 'Enter a phone number for the call';
  END IF;

  IF contact IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM crm.contacts WHERE id = contact AND tenant_id = p_tenant) THEN
      RAISE EXCEPTION 'Contact not found';
    END IF;
  ELSE
    contact := scheduler.find_contact(p_tenant, who, address, phone_number, p_staff);
  END IF;

  ends := p_start + svc.duration_minutes * interval '1 minute';
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
      meeting_id, source, created_by)
    VALUES (p_tenant, svc.id, p_staff, p_start, ends, ends + svc.buffer_minutes * interval '1 minute',
      who, nullif(address, ''), nullif(phone_number, ''), note, svc.location_type, svc.location_detail, contact,
      meeting, p_source, auth.uid())
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

  PERFORM scheduler.notify(p_tenant, p_staff, 'New booking: ' || who, svc.name || ', ' || said_when,
    '/saas/scheduler?date=' || to_char(p_start AT TIME ZONE zone, 'YYYY-MM-DD'), 'booking:' || booking || ':booked');
  RETURN booking;
END;
$$;

CREATE FUNCTION scheduler.do_cancel(p_booking UUID, p_reason TEXT, p_by_visitor BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
  svc_name TEXT;
  said_when TEXT;
  reason TEXT := nullif(btrim(coalesce(p_reason, '')), '');
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

-- App data for the signed-in person: their role, the settings, the team and their hours
CREATE FUNCTION scheduler.overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r TEXT := scheduler.role_of(p_tenant);
  s scheduler.settings;
BEGIN
  IF r IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  s := scheduler.ensure_settings(p_tenant);
  RETURN json_build_object(
    'role', r,
    'is_manager', r IN ('owner', 'admin'),
    'can_edit', r <> 'viewer',
    'me', auth.uid(),
    'settings', row_to_json(s),
    'today', to_char(now() AT TIME ZONE s.time_zone, 'YYYY-MM-DD'),
    'staff', coalesce((
      SELECT json_agg(json_build_object(
        'user_id', tm.user_id, 'email', u.email, 'role', tm.role, 'id', st.id,
        'display_name', coalesce(st.display_name, split_part(u.email, '@', 1)),
        'is_bookable', coalesce(st.is_bookable, false), 'set_up', st.user_id IS NOT NULL,
        'hours', coalesce((SELECT json_agg(json_build_object('weekday', h.weekday, 'start', to_char(h.start_time, 'HH24:MI'),
            'end', to_char(h.end_time, 'HH24:MI')) ORDER BY h.weekday, h.start_time)
          FROM scheduler.hours h WHERE h.tenant_id = p_tenant AND h.user_id = tm.user_id), '[]'::json))
        ORDER BY coalesce(st.display_name, u.email))
      FROM public.tenant_members tm
      JOIN auth.users u ON u.id = tm.user_id
      LEFT JOIN scheduler.staff st ON st.tenant_id = tm.tenant_id AND st.user_id = tm.user_id
      WHERE tm.tenant_id = p_tenant), '[]'::json),
    'next_7_days', (SELECT count(*) FROM scheduler.bookings WHERE tenant_id = p_tenant AND status = 'booked'
      AND starts_at >= now() AND starts_at < now() + interval '7 days')
  );
END;
$$;

CREATE FUNCTION scheduler.save_settings(p_tenant UUID, p_data JSONB)
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
    updated_at = now()
  WHERE tenant_id = p_tenant
  RETURNING * INTO s;
  RETURN row_to_json(s);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'Choose how often start times are offered';
END;
$$;

CREATE FUNCTION scheduler.new_booking_key(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  fresh TEXT := encode(extensions.gen_random_bytes(16), 'hex');
BEGIN
  PERFORM scheduler.require_manager(p_tenant);
  PERFORM scheduler.ensure_settings(p_tenant);
  UPDATE scheduler.settings SET booking_key = fresh, updated_at = now() WHERE tenant_id = p_tenant;
  RETURN json_build_object('booking_key', fresh);
END;
$$;

CREATE FUNCTION scheduler.save_service(p_tenant UUID, p_service UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  people UUID[];
  row_id UUID;
  label TEXT := btrim(coalesce(p_data->>'name', ''));
  kind TEXT := coalesce(p_data->>'location_type', 'in_person');
  cost NUMERIC;
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

  IF p_service IS NULL THEN
    INSERT INTO scheduler.services (tenant_id, name, description, duration_minutes, buffer_minutes, price,
      location_type, location_detail, staff_ids)
    VALUES (p_tenant, label, nullif(btrim(coalesce(p_data->>'description', '')), ''),
      scheduler.int_of(p_data->>'duration_minutes', 5, 480, 'Length must be between 5 and 480 minutes'),
      scheduler.int_of(coalesce(nullif(p_data->>'buffer_minutes', ''), '0'), 0, 240, 'Buffer must be between 0 and 240 minutes'),
      cost, kind, nullif(btrim(coalesce(p_data->>'location_detail', '')), ''), people)
    RETURNING id INTO row_id;
  ELSE
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
      updated_at = now()
    WHERE id = p_service AND tenant_id = p_tenant
    RETURNING id INTO row_id;
    IF row_id IS NULL THEN
      RAISE EXCEPTION 'Service not found';
    END IF;
  END IF;
  RETURN (SELECT row_to_json(v) FROM scheduler.services v WHERE v.id = row_id);
EXCEPTION
  WHEN unique_violation THEN RAISE EXCEPTION 'A service with that name already exists';
  WHEN check_violation THEN RAISE EXCEPTION 'Something in the form is too long';
END;
$$;

CREATE FUNCTION scheduler.delete_service(p_tenant UUID, p_service UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM scheduler.require_manager(p_tenant);
  IF EXISTS (SELECT 1 FROM scheduler.bookings WHERE service_id = p_service AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'This service has bookings. Turn it off instead of deleting it.';
  END IF;
  DELETE FROM scheduler.services WHERE id = p_service AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service not found';
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

-- A team member's name on the booking page, whether they take bookings, and their weekly hours.
-- People change their own; owners and admins can change anyone's.
CREATE FUNCTION scheduler.save_staff(p_tenant UUID, p_user UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  target_role TEXT;
  label TEXT := btrim(coalesce(p_data->>'display_name', ''));
  block JSONB;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  IF p_user IS DISTINCT FROM auth.uid() AND NOT scheduler.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'Only owners and admins can change someone else''s hours';
  END IF;
  SELECT role INTO target_role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = p_user;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'That person is not on the team';
  END IF;
  IF target_role = 'viewer' THEN
    RAISE EXCEPTION 'Viewers can''t take bookings. Change their role on the Team page first.';
  END IF;
  IF length(label) = 0 OR length(label) > 100 THEN
    RAISE EXCEPTION 'Enter the name visitors will see';
  END IF;
  IF jsonb_typeof(coalesce(p_data->'hours', '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(p_data->'hours', '[]'::jsonb)) > 28 THEN
    RAISE EXCEPTION 'Enter up to four blocks of hours a day';
  END IF;

  INSERT INTO scheduler.staff (tenant_id, user_id, display_name, is_bookable)
    VALUES (p_tenant, p_user, label, coalesce((p_data->>'is_bookable')::boolean, true))
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name, is_bookable = EXCLUDED.is_bookable;

  DELETE FROM scheduler.hours WHERE tenant_id = p_tenant AND user_id = p_user;
  FOR block IN SELECT * FROM jsonb_array_elements(coalesce(p_data->'hours', '[]'::jsonb)) LOOP
    IF coalesce(block->>'weekday', '') !~ '^[0-6]$'
       OR coalesce(block->>'start', '') !~ '^([01]\d|2[0-3]):[0-5]\d$'
       OR coalesce(block->>'end', '') !~ '^(([01]\d|2[0-3]):[0-5]\d|24:00)$' THEN
      RAISE EXCEPTION 'Enter hours like 09:00 to 17:00';
    END IF;
    IF (block->>'end') <> '24:00' AND (block->>'end')::time <= (block->>'start')::time THEN
      RAISE EXCEPTION 'Each block of hours must end after it starts';
    END IF;
    INSERT INTO scheduler.hours (tenant_id, user_id, weekday, start_time, end_time)
      VALUES (p_tenant, p_user, (block->>'weekday')::smallint, (block->>'start')::time,
        CASE WHEN block->>'end' = '24:00' THEN '23:59:59'::time ELSE (block->>'end')::time END);
  END LOOP;

  IF EXISTS (SELECT 1 FROM scheduler.hours a JOIN scheduler.hours b ON a.tenant_id = b.tenant_id AND a.user_id = b.user_id
      AND a.weekday = b.weekday AND a.id < b.id AND a.start_time < b.end_time AND b.start_time < a.end_time
      WHERE a.tenant_id = p_tenant AND a.user_id = p_user) THEN
    RAISE EXCEPTION 'Hours on the same day overlap';
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

CREATE FUNCTION scheduler.add_day_off(p_tenant UUID, p_user UUID, p_date DATE, p_note TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  row_id UUID;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  IF (p_user IS NULL OR p_user IS DISTINCT FROM auth.uid()) AND NOT scheduler.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'Only owners and admins can add days off for others or for the whole company';
  END IF;
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Choose a date';
  END IF;
  IF length(coalesce(p_note, '')) > 200 THEN
    RAISE EXCEPTION 'The note is too long';
  END IF;
  IF p_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM scheduler.staff WHERE tenant_id = p_tenant AND user_id = p_user) THEN
    RAISE EXCEPTION 'Set up opening hours first';
  END IF;
  INSERT INTO scheduler.days_off (tenant_id, user_id, off_date, note, created_by)
    VALUES (p_tenant, p_user, p_date, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
    RETURNING id INTO row_id;
  RETURN (SELECT row_to_json(o) FROM scheduler.days_off o WHERE o.id = row_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'That day is already off';
END;
$$;

CREATE FUNCTION scheduler.delete_day_off(p_tenant UUID, p_day UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  o scheduler.days_off;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  SELECT * INTO o FROM scheduler.days_off WHERE id = p_day AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Day off not found';
  END IF;
  IF (o.user_id IS NULL OR o.user_id IS DISTINCT FROM auth.uid()) AND NOT scheduler.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'Only owners and admins can do that';
  END IF;
  DELETE FROM scheduler.days_off WHERE id = o.id;
  RETURN json_build_object('success', true);
END;
$$;

-- Bookings and meetings over some days, as dates and times in the company's time zone
CREATE FUNCTION scheduler.calendar(p_tenant UUID, p_from DATE, p_days INT, p_staff UUID, p_cancelled BOOLEAN)
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
  IF p_from IS NULL OR p_days IS NULL OR p_days < 1 OR p_days > 42 THEN
    RAISE EXCEPTION 'Choose up to 6 weeks';
  END IF;
  from_at := p_from::timestamp AT TIME ZONE zone;
  to_at := (p_from + p_days)::timestamp AT TIME ZONE zone;
  RETURN json_build_object(
    'time_zone', zone,
    'today', to_char(now() AT TIME ZONE zone, 'YYYY-MM-DD'),
    'bookings', coalesce((SELECT json_agg(scheduler.booking_json(b.id) ORDER BY b.starts_at)
      FROM scheduler.bookings b
      WHERE b.tenant_id = p_tenant AND b.starts_at < to_at AND b.ends_at > from_at
        AND (p_staff IS NULL OR b.staff_id = p_staff) AND (p_cancelled OR b.status = 'booked')), '[]'::json),
    'meetings', coalesce((SELECT json_agg(scheduler.meeting_json(m.id) ORDER BY m.starts_at)
      FROM scheduler.meetings m
      WHERE m.tenant_id = p_tenant AND m.status = 'scheduled' AND m.starts_at < to_at
        AND m.starts_at + m.duration_minutes * interval '1 minute' > from_at
        AND (p_staff IS NULL OR m.host_id = p_staff)
        AND NOT EXISTS (SELECT 1 FROM scheduler.bookings b WHERE b.meeting_id = m.id)), '[]'::json)
  );
END;
$$;

-- Free start times for staff making a booking. Staff aren't held to the minimum notice.
CREATE FUNCTION scheduler.free_times(p_tenant UUID, p_service UUID, p_staff UUID, p_date DATE, p_booking UUID)
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
      'staff_id', f.slot_staff, 'staff_name', st.display_name) ORDER BY f.slot_start, st.display_name)
    FROM scheduler.free_slots(p_tenant, p_service, p_staff, p_date, p_date, false, p_booking) f
    JOIN scheduler.staff st ON st.tenant_id = p_tenant AND st.user_id = f.slot_staff), '[]'::json);
END;
$$;

CREATE FUNCTION scheduler.create_booking(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  booking UUID;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  booking := scheduler.place_booking(p_tenant, (p_data->>'service_id')::uuid, (p_data->>'staff_id')::uuid,
    scheduler.local_start(scheduler.tz(p_tenant), p_data->>'date', p_data->>'time'),
    p_data, nullif(p_data->>'contact_id', '')::uuid, 'staff');
  RETURN scheduler.booking_json(booking);
END;
$$;

-- Moves a booking to a new time or person, keeping its length and buffer
CREATE FUNCTION scheduler.reschedule_booking(p_tenant UUID, p_booking UUID, p_data JSONB)
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

CREATE FUNCTION scheduler.cancel_booking(p_tenant UUID, p_booking UUID, p_reason TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM scheduler.bookings WHERE id = p_booking AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  PERFORM scheduler.do_cancel(p_booking, p_reason, false);
  RETURN scheduler.booking_json(p_booking);
END;
$$;

-- Video meetings
CREATE FUNCTION scheduler.meeting_contacts_from(p_tenant UUID, p_data JSONB)
RETURNS UUID[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  picked UUID[];
BEGIN
  IF jsonb_typeof(coalesce(p_data->'contact_ids', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Choose who to invite';
  END IF;
  picked := ARRAY(SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(coalesce(p_data->'contact_ids', '[]'::jsonb)) x);
  IF cardinality(picked) > 25 THEN
    RAISE EXCEPTION 'Invite up to 25 contacts';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(picked) cid WHERE NOT EXISTS (SELECT 1 FROM crm.contacts c WHERE c.id = cid AND c.tenant_id = p_tenant)) THEN
    RAISE EXCEPTION 'Contact not found';
  END IF;
  RETURN picked;
END;
$$;

CREATE FUNCTION scheduler.create_meeting(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  zone TEXT := scheduler.tz(p_tenant);
  start_now BOOLEAN := coalesce((p_data->>'now')::boolean, false);
  label TEXT := btrim(coalesce(p_data->>'title', ''));
  starts TIMESTAMPTZ;
  people UUID[];
  meeting scheduler.meetings;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  IF start_now AND label = '' THEN
    label := 'Quick meeting';
  END IF;
  IF length(label) = 0 OR length(label) > 200 THEN
    RAISE EXCEPTION 'Enter a title';
  END IF;
  IF length(coalesce(p_data->>'notes', '')) > 2000 THEN
    RAISE EXCEPTION 'The notes are too long';
  END IF;
  starts := CASE WHEN start_now THEN now() ELSE scheduler.local_start(zone, p_data->>'date', p_data->>'time') END;
  people := scheduler.meeting_contacts_from(p_tenant, p_data);

  INSERT INTO scheduler.meetings (tenant_id, title, starts_at, duration_minutes, room_url, host_id, notes, created_by)
    VALUES (p_tenant, label, starts,
      scheduler.int_of(coalesce(nullif(p_data->>'duration_minutes', ''), '30'), 5, 720, 'Length must be between 5 and 720 minutes'),
      scheduler.room_url(p_tenant), auth.uid(), nullif(btrim(coalesce(p_data->>'notes', '')), ''), auth.uid())
    RETURNING * INTO meeting;
  INSERT INTO scheduler.meeting_contacts (meeting_id, contact_id, tenant_id) SELECT meeting.id, cid, p_tenant FROM unnest(people) cid;
  INSERT INTO crm.activities (tenant_id, kind, subject, body, contact_id, owner_id)
    SELECT p_tenant, 'meeting', left('Video meeting: ' || label || ' on ' || scheduler.when_text(starts, zone), 300),
      'Join on Jitsi Meet: ' || meeting.room_url, cid, auth.uid()
    FROM unnest(people) cid;
  RETURN scheduler.meeting_json(meeting.id);
END;
$$;

CREATE FUNCTION scheduler.update_meeting(p_tenant UUID, p_meeting UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m scheduler.meetings;
  label TEXT := btrim(coalesce(p_data->>'title', ''));
  people UUID[];
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  SELECT * INTO m FROM scheduler.meetings WHERE id = p_meeting AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meeting not found';
  END IF;
  IF m.host_id IS DISTINCT FROM auth.uid() AND NOT scheduler.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'Only the host, owners and admins can change this meeting';
  END IF;
  IF EXISTS (SELECT 1 FROM scheduler.bookings WHERE meeting_id = m.id) THEN
    RAISE EXCEPTION 'This meeting comes from a booking. Change the booking in Scheduler instead.';
  END IF;
  IF m.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This meeting is cancelled';
  END IF;
  IF length(label) = 0 OR length(label) > 200 THEN
    RAISE EXCEPTION 'Enter a title';
  END IF;
  IF length(coalesce(p_data->>'notes', '')) > 2000 THEN
    RAISE EXCEPTION 'The notes are too long';
  END IF;
  people := scheduler.meeting_contacts_from(p_tenant, p_data);
  UPDATE scheduler.meetings SET
    title = label,
    starts_at = scheduler.local_start(scheduler.tz(p_tenant), p_data->>'date', p_data->>'time'),
    duration_minutes = scheduler.int_of(coalesce(nullif(p_data->>'duration_minutes', ''), '30'), 5, 720, 'Length must be between 5 and 720 minutes'),
    notes = nullif(btrim(coalesce(p_data->>'notes', '')), '')
  WHERE id = m.id;
  DELETE FROM scheduler.meeting_contacts WHERE meeting_id = m.id AND contact_id <> ALL (people);
  INSERT INTO scheduler.meeting_contacts (meeting_id, contact_id, tenant_id)
    SELECT m.id, cid, p_tenant FROM unnest(people) cid ON CONFLICT DO NOTHING;
  RETURN scheduler.meeting_json(m.id);
END;
$$;

CREATE FUNCTION scheduler.cancel_meeting(p_tenant UUID, p_meeting UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m scheduler.meetings;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  SELECT * INTO m FROM scheduler.meetings WHERE id = p_meeting AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meeting not found';
  END IF;
  IF m.host_id IS DISTINCT FROM auth.uid() AND NOT scheduler.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'Only the host, owners and admins can cancel this meeting';
  END IF;
  IF EXISTS (SELECT 1 FROM scheduler.bookings WHERE meeting_id = m.id) THEN
    RAISE EXCEPTION 'This meeting comes from a booking. Cancel the booking in Scheduler instead.';
  END IF;
  UPDATE scheduler.meetings SET status = 'cancelled' WHERE id = m.id;
  RETURN scheduler.meeting_json(m.id);
END;
$$;

CREATE FUNCTION scheduler.list_meetings(p_tenant UUID, p_past BOOLEAN)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT scheduler.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_past THEN
    RETURN coalesce((SELECT json_agg(scheduler.meeting_json(x.id) ORDER BY x.starts_at DESC) FROM (
      SELECT m.id, m.starts_at FROM scheduler.meetings m WHERE m.tenant_id = p_tenant
        AND (m.status = 'cancelled' OR m.starts_at + m.duration_minutes * interval '1 minute' <= now())
      ORDER BY m.starts_at DESC LIMIT 100) x), '[]'::json);
  END IF;
  RETURN coalesce((SELECT json_agg(scheduler.meeting_json(x.id) ORDER BY x.starts_at) FROM (
    SELECT m.id, m.starts_at FROM scheduler.meetings m WHERE m.tenant_id = p_tenant AND m.status = 'scheduled'
      AND m.starts_at + m.duration_minutes * interval '1 minute' > now()
    ORDER BY m.starts_at LIMIT 200) x), '[]'::json);
END;
$$;

-- The public booking page. There is no signed-in user, so the company is found by its private key.
CREATE FUNCTION public.booking_page(p_key TEXT)
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

CREATE FUNCTION public.booking_slots(p_key TEXT, p_service UUID, p_staff UUID, p_from DATE, p_days INT)
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
  RETURN coalesce((
    SELECT json_agg(json_build_object('start', f.slot_start,
      'date', to_char(f.slot_start AT TIME ZONE s.time_zone, 'YYYY-MM-DD'),
      'time', to_char(f.slot_start AT TIME ZONE s.time_zone, 'HH24:MI')) ORDER BY f.slot_start)
    FROM (SELECT DISTINCT x.slot_start FROM scheduler.free_slots(s.tenant_id, p_service, person, p_from, p_from + p_days - 1, true, NULL) x) f
  ), '[]'::json);
END;
$$;

CREATE FUNCTION public.book_slot(p_key TEXT, p_service UUID, p_staff UUID, p_start TIMESTAMPTZ, p_visitor JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s scheduler.settings;
  person UUID;
  chosen UUID;
  booking UUID;
  local_day DATE;
  address TEXT := lower(btrim(coalesce(p_visitor->>'email', '')));
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

  -- A spam attack stops here instead of filling the calendar
  IF (SELECT count(*) FROM scheduler.bookings WHERE tenant_id = s.tenant_id AND source = 'public'
      AND created_at > now() - interval '1 day') >= 300 THEN
    RAISE EXCEPTION 'Booking is busy right now. Please try again later.';
  END IF;
  IF (SELECT count(*) FROM scheduler.bookings WHERE tenant_id = s.tenant_id AND status = 'booked'
      AND lower(customer_email) = address AND starts_at > now()) >= 5 THEN
    RAISE EXCEPTION 'You already have 5 upcoming bookings. Cancel one to book another.';
  END IF;

  -- The time must still be free. With anyone, the person with the fewest upcoming bookings gets it.
  local_day := (p_start AT TIME ZONE s.time_zone)::date;
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
    jsonb_build_object('name', p_visitor->>'name', 'email', address, 'phone', p_visitor->>'phone', 'notes', p_visitor->>'notes'),
    NULL, 'public');
  RETURN (scheduler.visitor_json(booking)::jsonb
    || jsonb_build_object('token', (SELECT token FROM scheduler.booking_tokens WHERE booking_id = booking)))::json;
END;
$$;

CREATE FUNCTION public.booking_by_token(p_token TEXT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT scheduler.visitor_json(k.booking_id) FROM scheduler.booking_tokens k
  WHERE p_token ~ '^[0-9a-f]{64}$' AND k.token = p_token;
$$;

CREATE FUNCTION public.cancel_booking_by_token(p_token TEXT, p_reason TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  b scheduler.bookings;
BEGIN
  SELECT bk.* INTO b FROM scheduler.booking_tokens k JOIN scheduler.bookings bk ON bk.id = k.booking_id
    WHERE coalesce(p_token, '') ~ '^[0-9a-f]{64}$' AND k.token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  IF b.status <> 'booked' THEN
    RAISE EXCEPTION 'This booking is already cancelled';
  END IF;
  IF b.starts_at <= now() THEN
    RAISE EXCEPTION 'This booking has already started, so it can''t be cancelled here';
  END IF;
  PERFORM scheduler.do_cancel(b.id, left(p_reason, 500), true);
  RETURN scheduler.visitor_json(b.id);
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Helpers used inside other functions, never called directly
  FOREACH fn IN ARRAY ARRAY['scheduler.role_of(uuid)', 'scheduler.require_staff(uuid)', 'scheduler.require_manager(uuid)',
      'scheduler.ensure_settings(uuid)', 'scheduler.tz(uuid)', 'scheduler.when_text(timestamptz, text)',
      'scheduler.local_start(text, text, text)', 'scheduler.int_of(text, integer, integer, text)', 'scheduler.room_url(uuid)',
      'scheduler.find_contact(uuid, text, text, text, uuid)', 'scheduler.notify(uuid, uuid, text, text, text, text)',
      'scheduler.current_member(uuid, uuid)',
      'scheduler.free_slots(uuid, uuid, uuid, date, date, boolean, uuid)', 'scheduler.booking_json(uuid)',
      'scheduler.meeting_json(uuid)', 'scheduler.visitor_json(uuid)',
      'scheduler.place_booking(uuid, uuid, uuid, timestamptz, jsonb, uuid, text)', 'scheduler.do_cancel(uuid, text, boolean)',
      'scheduler.meeting_contacts_from(uuid, jsonb)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['scheduler.is_member(uuid)', 'scheduler.is_manager(uuid)', 'scheduler.overview(uuid)',
      'scheduler.save_settings(uuid, jsonb)', 'scheduler.new_booking_key(uuid)', 'scheduler.save_service(uuid, uuid, jsonb)',
      'scheduler.delete_service(uuid, uuid)', 'scheduler.save_staff(uuid, uuid, jsonb)',
      'scheduler.add_day_off(uuid, uuid, date, text)', 'scheduler.delete_day_off(uuid, uuid)',
      'scheduler.calendar(uuid, date, integer, uuid, boolean)', 'scheduler.free_times(uuid, uuid, uuid, date, uuid)',
      'scheduler.create_booking(uuid, jsonb)', 'scheduler.reschedule_booking(uuid, uuid, jsonb)',
      'scheduler.cancel_booking(uuid, uuid, text)', 'scheduler.create_meeting(uuid, jsonb)',
      'scheduler.update_meeting(uuid, uuid, jsonb)', 'scheduler.cancel_meeting(uuid, uuid)',
      'scheduler.list_meetings(uuid, boolean)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
  -- The public booking page, for visitors who are not signed in
  FOREACH fn IN ARRAY ARRAY['public.booking_page(text)', 'public.booking_slots(text, uuid, uuid, date, integer)',
      'public.book_slot(text, uuid, uuid, timestamptz, jsonb)', 'public.booking_by_token(text)',
      'public.cancel_booking_by_token(text, text)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', fn);
  END LOOP;
END;
$$;

-- Adds this schema to the API, keeping every schema already listed (other products add theirs too)
DO $$
DECLARE
  current_list TEXT;
BEGIN
  SELECT substring(c FROM 'pgrst.db_schemas=(.*)') INTO current_list
    FROM pg_roles r, unnest(r.rolconfig) c WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%';
  current_list := coalesce(current_list, 'public, graphql_public');
  IF NOT ('scheduler' = ANY (string_to_array(replace(current_list, ' ', ''), ','))) THEN
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', current_list || ', scheduler');
  END IF;
END;
$$;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
