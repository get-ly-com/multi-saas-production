-- Scheduler: block busy times from each person's own Google, Outlook or Apple calendar.
-- 1. Each team member can save the private iCal address of their own calendar. The address is
--    kept in vault.secrets (encrypted); the table only keeps a short hint to show. Only the
--    scheduler service (service_role) can read the address back, to download the calendar.
-- 2. The service downloads each calendar every 15 minutes (the worker asks it to) and replaces
--    that calendar's busy times in scheduler.busy_blocks. Only start and end times are kept:
--    no titles, places or people. The last check and the last problem are kept to show.
-- 3. Free times skip busy blocks the same way they skip bookings, so the booking page, moving a
--    booking from a visitor link and booking by hand never offer them. Booking or moving into
--    one by hand is refused with a plain reason (the same check as leave and holidays).
-- 4. Our own bookings and meetings coming back through the person's calendar (when they
--    subscribe to their get-ly feed) are recognised by the feed's event UID and ignored.

-- ---------------------------------------------------------------- Tables
CREATE TABLE IF NOT EXISTS scheduler.busy_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The address itself lives in vault.secrets
  secret_id UUID NOT NULL,
  url_hint TEXT NOT NULL,
  last_checked_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT CHECK (length(last_error) <= 300),
  busy_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_busy_feeds_user ON scheduler.busy_feeds (user_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_busy_feeds_due ON scheduler.busy_feeds (last_checked_at NULLS FIRST);
ALTER TABLE scheduler.busy_feeds ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS scheduler.busy_blocks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feed_id UUID NOT NULL REFERENCES scheduler.busy_feeds(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_busy_blocks_person ON scheduler.busy_blocks (tenant_id, user_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_busy_blocks_feed ON scheduler.busy_blocks (feed_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_busy_blocks_user ON scheduler.busy_blocks (user_id);
ALTER TABLE scheduler.busy_blocks ENABLE ROW LEVEL SECURITY;
-- No policies and no grants: like calendar_feeds and booking_tokens, only the functions below use them.

-- A removed calendar (or person, or company) takes its address with it
CREATE OR REPLACE FUNCTION scheduler.drop_busy_secret()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.secret_id;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS drop_busy_secret ON scheduler.busy_feeds;
CREATE TRIGGER drop_busy_secret AFTER DELETE ON scheduler.busy_feeds
  FOR EACH ROW EXECUTE FUNCTION scheduler.drop_busy_secret();

-- ---------------------------------------------------------------- Helpers
-- Only the private iCal addresses of Google, Outlook and iCloud. The service checks the same
-- rules again, and also refuses private networks and redirects, when it downloads.
CREATE OR REPLACE FUNCTION scheduler.busy_url_problem(p_url TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN coalesce(p_url, '') = '' THEN 'Paste your calendar''s secret address'
    WHEN length(p_url) > 2000 THEN 'That address is too long'
    WHEN p_url ~ '[[:space:]]' THEN 'That address has spaces in it. Copy it again.'
    WHEN p_url !~* '^https://' THEN 'The address must start with https://'
    WHEN lower(substring(p_url FROM '^https://([^/?#]*)')) !~
      '^(calendar\.google\.com|outlook\.office365\.com|outlook\.live\.com|p[0-9]+-caldav\.icloud\.com)$'
      THEN 'Use the secret iCal address from Google Calendar, Outlook or Apple iCloud'
  END;
$$;

-- An event UID from our own /feed (bookings and meetings of this company), coming back
CREATE OR REPLACE FUNCTION scheduler.is_own_echo(p_tenant UUID, p_uid TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  u UUID;
  kind TEXT;
BEGIN
  IF lower(coalesce(p_uid, '')) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@(scheduler|meeting|booking)$' THEN
    RETURN false;
  END IF;
  u := split_part(lower(p_uid), '@', 1)::uuid;
  kind := split_part(lower(p_uid), '@', 2);
  IF kind = 'meeting' THEN
    RETURN EXISTS (SELECT 1 FROM scheduler.meetings m WHERE m.id = u AND m.tenant_id = p_tenant);
  END IF;
  RETURN EXISTS (SELECT 1 FROM scheduler.bookings b WHERE b.id = u AND b.tenant_id = p_tenant)
    OR EXISTS (SELECT 1 FROM scheduler.bookings b WHERE b.session_key = u AND b.tenant_id = p_tenant);
END;
$$;

-- ---------------------------------------------------------------- For the signed-in person
-- Their own calendar: a hint of the address, when it was last checked and any problem
CREATE OR REPLACE FUNCTION scheduler.busy_feed(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT scheduler.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN json_build_object('now', now(), 'feed', (
    SELECT json_build_object('hint', f.url_hint, 'last_checked_at', f.last_checked_at,
      'last_synced_at', f.last_synced_at, 'last_error', f.last_error, 'busy_count', f.busy_count,
      'created_at', f.created_at)
    FROM scheduler.busy_feeds f WHERE f.tenant_id = p_tenant AND f.user_id = auth.uid()));
END;
$$;

CREATE OR REPLACE FUNCTION scheduler.save_busy_feed(p_tenant UUID, p_url TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  clean TEXT := regexp_replace(btrim(coalesce(p_url, '')), '^webcals?://', 'https://', 'i');
  problem TEXT := scheduler.busy_url_problem(clean);
  f scheduler.busy_feeds;
  hint TEXT;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION '%', problem;
  END IF;
  hint := lower(substring(clean FROM '^https://([^/?#]*)')) || ' ending '
    || right(regexp_replace(split_part(split_part(clean, '#', 1), '?', 1), '(/basic|/calendar)?\.ics$', '', 'i'), 4);
  SELECT * INTO f FROM scheduler.busy_feeds WHERE tenant_id = p_tenant AND user_id = auth.uid() FOR UPDATE;
  IF FOUND THEN
    PERFORM vault.update_secret(f.secret_id, clean);
    DELETE FROM scheduler.busy_blocks WHERE feed_id = f.id;
    UPDATE scheduler.busy_feeds SET url_hint = hint, last_checked_at = NULL, last_synced_at = NULL,
      last_error = NULL, busy_count = 0, updated_at = now()
      WHERE id = f.id;
  ELSE
    INSERT INTO scheduler.busy_feeds (tenant_id, user_id, secret_id, url_hint)
      VALUES (p_tenant, auth.uid(),
        vault.create_secret(clean, 'scheduler_busy_feed_' || gen_random_uuid(), 'Private calendar address for busy times'),
        hint);
  END IF;
  RETURN scheduler.busy_feed(p_tenant);
END;
$$;

CREATE OR REPLACE FUNCTION scheduler.remove_busy_feed(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT scheduler.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  DELETE FROM scheduler.busy_feeds WHERE tenant_id = p_tenant AND user_id = auth.uid();
  RETURN scheduler.busy_feed(p_tenant);
END;
$$;

-- "Check now": at most once a minute. Returns the calendar's id for the service to download.
CREATE OR REPLACE FUNCTION scheduler.busy_check_start(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  f scheduler.busy_feeds;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  SELECT * INTO f FROM scheduler.busy_feeds WHERE tenant_id = p_tenant AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Add your calendar''s secret address first';
  END IF;
  IF f.last_checked_at > now() - interval '1 minute' THEN
    RAISE EXCEPTION 'It was checked less than a minute ago. Please try again in a minute.';
  END IF;
  UPDATE scheduler.busy_feeds SET last_checked_at = now() WHERE id = f.id;
  RETURN json_build_object('feed_id', f.id);
END;
$$;

-- ---------------------------------------------------------------- For the scheduler service only
-- Calendars not checked in the last 14 minutes, claimed so two runs don't take the same one
CREATE OR REPLACE FUNCTION scheduler.busy_sync_due(p_limit INT)
RETURNS TABLE (feed_id UUID, url TEXT, time_zone TEXT)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH due AS (
    SELECT f.id FROM scheduler.busy_feeds f
    WHERE (f.last_checked_at IS NULL OR f.last_checked_at < now() - interval '14 minutes')
      AND EXISTS (SELECT 1 FROM public.tenant_members tm WHERE tm.tenant_id = f.tenant_id AND tm.user_id = f.user_id)
      AND EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = f.tenant_id AND t.is_active IS NOT FALSE)
    ORDER BY f.last_checked_at NULLS FIRST
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
    FOR UPDATE OF f SKIP LOCKED
  )
  UPDATE scheduler.busy_feeds f SET last_checked_at = now()
  FROM due WHERE f.id = due.id
  RETURNING f.id,
    (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.id = f.secret_id),
    scheduler.tz(f.tenant_id);
$$;

-- One calendar, for "Check now" (after busy_check_start) and right after it is saved
CREATE OR REPLACE FUNCTION scheduler.busy_sync_claim(p_feed UUID)
RETURNS TABLE (feed_id UUID, url TEXT, time_zone TEXT)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE scheduler.busy_feeds f SET last_checked_at = now()
  WHERE f.id = p_feed
  RETURNING f.id,
    (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.id = f.secret_id),
    scheduler.tz(f.tenant_id);
$$;

-- Replace one calendar's busy times, or note the problem (keeping the last good busy times).
-- p_blocks: [{ "start": ISO time, "end": ISO time, "uid": event UID }], up to 5000, next 60 days.
CREATE OR REPLACE FUNCTION scheduler.busy_sync_save(p_feed UUID, p_blocks JSONB, p_error TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  f scheduler.busy_feeds;
  n INT;
BEGIN
  SELECT * INTO f FROM scheduler.busy_feeds WHERE id = p_feed FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('saved', false);
  END IF;
  IF p_error IS NOT NULL THEN
    UPDATE scheduler.busy_feeds SET last_error = left(p_error, 300), last_checked_at = now() WHERE id = f.id;
    RETURN json_build_object('saved', true, 'error', left(p_error, 300));
  END IF;
  IF jsonb_typeof(coalesce(p_blocks, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Busy times must be a list';
  END IF;

  DELETE FROM scheduler.busy_blocks WHERE feed_id = f.id;
  INSERT INTO scheduler.busy_blocks (tenant_id, user_id, feed_id, starts_at, ends_at)
  SELECT f.tenant_id, f.user_id, f.id, greatest(b.s, now() - interval '1 day'), least(b.e, now() + interval '61 days')
  FROM (
    SELECT (x->>'start')::timestamptz AS s, (x->>'end')::timestamptz AS e, x->>'uid' AS uid
    FROM jsonb_array_elements(p_blocks) x
    WHERE jsonb_typeof(x) = 'object'
    LIMIT 5000
  ) b
  WHERE b.e > b.s AND b.e > now() - interval '1 day' AND b.s < now() + interval '61 days'
    AND NOT scheduler.is_own_echo(f.tenant_id, b.uid);
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE scheduler.busy_feeds SET last_synced_at = now(), last_checked_at = now(), last_error = NULL, busy_count = n
    WHERE id = f.id;
  RETURN json_build_object('saved', true, 'busy_count', n);
END;
$$;

-- ---------------------------------------------------------------- Slots skip busy blocks
-- Same as before, plus: no start time that overlaps a busy block (with the service's buffer).
CREATE OR REPLACE FUNCTION scheduler.free_slots(p_tenant uuid, p_service uuid, p_staff uuid, p_from date, p_to date, p_notice boolean, p_ignore_booking uuid)
 RETURNS TABLE(slot_start timestamp with time zone, slot_staff uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    AND NOT EXISTS (
      SELECT 1 FROM scheduler.busy_blocks bb
      WHERE bb.tenant_id = p_tenant AND bb.user_id = c.user_id
        AND bb.starts_at < c.slot + (svc.duration_minutes + svc.buffer_minutes) * interval '1 minute'
        AND bb.ends_at > c.slot)
  ORDER BY c.slot, c.user_id;
END;
$function$;

-- Booking or moving by hand: leave and holidays as before, then busy times from their own
-- calendar. Staff can still go ahead after the warning (override_away), visitors never can.
CREATE OR REPLACE FUNCTION scheduler.away_during(p_tenant uuid, p_user uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT coalesce(
    (SELECT scheduler.away_reason(p_tenant, p_user, d::date)
      FROM generate_series((p_start AT TIME ZONE scheduler.tz(p_tenant))::date::timestamp,
        ((p_end - interval '1 second') AT TIME ZONE scheduler.tz(p_tenant))::date::timestamp, interval '1 day') d
      WHERE scheduler.away_reason(p_tenant, p_user, d::date) IS NOT NULL
      ORDER BY d LIMIT 1),
    (SELECT 'That person is busy then in their own calendar' FROM scheduler.busy_blocks bb
      WHERE bb.tenant_id = p_tenant AND bb.user_id = p_user AND bb.starts_at < p_end AND bb.ends_at > p_start
      LIMIT 1));
$function$;

-- ---------------------------------------------------------------- Access
REVOKE EXECUTE ON FUNCTION
  scheduler.drop_busy_secret(),
  scheduler.busy_url_problem(TEXT),
  scheduler.is_own_echo(UUID, TEXT),
  scheduler.busy_feed(UUID),
  scheduler.save_busy_feed(UUID, TEXT),
  scheduler.remove_busy_feed(UUID),
  scheduler.busy_check_start(UUID),
  scheduler.busy_sync_due(INT),
  scheduler.busy_sync_claim(UUID),
  scheduler.busy_sync_save(UUID, JSONB, TEXT),
  scheduler.free_slots(UUID, UUID, UUID, DATE, DATE, BOOLEAN, UUID),
  scheduler.away_during(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  scheduler.busy_feed(UUID),
  scheduler.save_busy_feed(UUID, TEXT),
  scheduler.remove_busy_feed(UUID),
  scheduler.busy_check_start(UUID)
  TO authenticated;

-- Only the scheduler service reads the addresses and writes busy times
GRANT EXECUTE ON FUNCTION
  scheduler.busy_sync_due(INT),
  scheduler.busy_sync_claim(UUID),
  scheduler.busy_sync_save(UUID, JSONB, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';
