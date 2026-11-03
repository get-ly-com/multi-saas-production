-- Social media planner. Companies list their social accounts (no passwords or tokens), plan posts with
-- text for each account, an optional image, a date, a person who looks after it and an optional approval
-- step. Nothing is published from here: people post from the platform themself, then mark it as posted
-- with the live link. Everyone in the company can read the plan; viewers can't change it; owners and
-- admins approve posts and change the settings. Every change goes through the functions below.

CREATE SCHEMA IF NOT EXISTS social;
GRANT USAGE ON SCHEMA social TO authenticated, service_role;

-- Role checks
CREATE FUNCTION social.role_in(p_tenant UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid();
$$;

CREATE FUNCTION social.is_member(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid());
$$;

-- Anyone in the company except viewers
CREATE FUNCTION social.can_edit(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_members
    WHERE tenant_id = p_tenant AND user_id = auth.uid() AND role IN ('owner', 'admin', 'accountant'));
$$;

CREATE FUNCTION social.require_editor(p_tenant UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT := social.role_in(p_tenant);
BEGIN
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF v_role = 'viewer' THEN
    RAISE EXCEPTION 'Your role can only view this company';
  END IF;
  RETURN v_role;
END;
$$;

-- Each platform's text limit, in characters
CREATE FUNCTION social.char_limit(p_platform TEXT)
RETURNS INT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE p_platform WHEN 'x' THEN 280 WHEN 'linkedin' THEN 3000 WHEN 'facebook' THEN 63206 WHEN 'instagram' THEN 2200 END;
$$;

CREATE FUNCTION social.platform_name(p_platform TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE p_platform WHEN 'x' THEN 'X' WHEN 'linkedin' THEN 'LinkedIn' WHEN 'facebook' THEN 'Facebook'
    WHEN 'instagram' THEN 'Instagram' ELSE p_platform END;
$$;

-- A web link with no user name or password in it
CREATE FUNCTION social.is_web_link(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_value IS NOT NULL AND length(p_value) <= 500 AND p_value ~* '^https?://[^/@\s:]+(:[0-9]+)?(/\S*)?$';
$$;

-- A value that isn't a uuid gives null instead of an error
CREATE FUNCTION social.uuid_or_null(p_value TEXT)
RETURNS UUID
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_value::uuid END;
$$;

-- Company settings. Approval is off until an owner or admin turns it on.
CREATE TABLE social.settings (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  require_approval BOOLEAN NOT NULL DEFAULT false,
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
ALTER TABLE social.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON social.settings FOR SELECT TO authenticated USING (social.is_member(tenant_id));
GRANT SELECT ON social.settings TO authenticated;

-- The company's accounts: platform, handle and profile link only
CREATE TABLE social.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('x', 'linkedin', 'facebook', 'instagram')),
  handle TEXT NOT NULL CHECK (length(btrim(handle)) BETWEEN 1 AND 100),
  profile_url TEXT CHECK (profile_url IS NULL OR social.is_web_link(profile_url)),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_social_accounts_handle ON social.accounts (tenant_id, platform, lower(handle));
CREATE INDEX idx_social_accounts_created_by ON social.accounts (created_by);
ALTER TABLE social.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON social.accounts FOR SELECT TO authenticated USING (social.is_member(tenant_id));
GRANT SELECT ON social.accounts TO authenticated;

CREATE TABLE social.posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  campaign TEXT CHECK (length(campaign) <= 100),
  tags TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  link_url TEXT CHECK (link_url IS NULL OR social.is_web_link(link_url)),
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'needs_approval', 'approved', 'scheduled', 'posted')),
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  image_path TEXT UNIQUE CHECK (length(image_path) <= 500),
  image_size BIGINT CHECK (image_size > 0 AND image_size <= 5242880),
  image_mime TEXT CHECK (image_mime IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
  notes TEXT CHECK (length(notes) <= 2000),
  review_note TEXT CHECK (length(review_note) <= 500),
  submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMP,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  posted_at TIMESTAMP,
  created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CHECK ((image_path IS NULL) = (image_size IS NULL))
);
CREATE INDEX idx_social_posts_schedule ON social.posts (tenant_id, scheduled_at);
CREATE INDEX idx_social_posts_status ON social.posts (tenant_id, status);
CREATE INDEX idx_social_posts_assigned_to ON social.posts (assigned_to);
CREATE INDEX idx_social_posts_created_by ON social.posts (created_by);
CREATE INDEX idx_social_posts_submitted_by ON social.posts (submitted_by);
CREATE INDEX idx_social_posts_approved_by ON social.posts (approved_by);
ALTER TABLE social.posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON social.posts FOR SELECT TO authenticated USING (social.is_member(tenant_id));
GRANT SELECT ON social.posts TO authenticated;

-- One row per account a post goes to, with that account's own text and, once out, its live link
CREATE TABLE social.post_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES social.posts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES social.accounts(id),
  platform TEXT NOT NULL CHECK (platform IN ('x', 'linkedin', 'facebook', 'instagram')),
  body TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= social.char_limit(platform)),
  posted_at TIMESTAMP,
  post_url TEXT CHECK (post_url IS NULL OR social.is_web_link(post_url)),
  posted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (post_id, account_id)
);
CREATE INDEX idx_social_post_targets_account ON social.post_targets (account_id);
CREATE INDEX idx_social_post_targets_tenant ON social.post_targets (tenant_id);
CREATE INDEX idx_social_post_targets_posted_by ON social.post_targets (posted_by);
ALTER TABLE social.post_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON social.post_targets FOR SELECT TO authenticated USING (social.is_member(tenant_id));
GRANT SELECT ON social.post_targets TO authenticated;

-- Images. Public to read (platforms and people need the link), at '<tenant_id>/<uuid>-<file name>'.
-- People in the company who aren't viewers upload and delete in their company's folder.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('social-media', 'social-media', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Bytes stored for a company in the bucket, including files not yet on a post
CREATE FUNCTION social.image_space_used(p_tenant UUID)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(sum(coalesce((metadata->>'size')::bigint, 0)), 0)::bigint FROM storage.objects
  WHERE bucket_id = 'social-media' AND name LIKE p_tenant::text || '/%';
$$;

-- The company whose folder a file is in, or null when the path isn't exactly '<tenant>/<file>'
CREATE FUNCTION social.image_tenant(p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  folders TEXT[] := storage.foldername(p_name);
BEGIN
  IF coalesce(array_length(folders, 1), 0) <> 1 THEN
    RETURN NULL;
  END IF;
  RETURN social.uuid_or_null(folders[1]);
END;
$$;

CREATE FUNCTION social.can_upload_image(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tenant UUID := social.image_tenant(p_name);
BEGIN
  RETURN v_tenant IS NOT NULL AND social.can_edit(v_tenant) AND social.image_space_used(v_tenant) < 104857600;
END;
$$;

CREATE FUNCTION social.can_read_image(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tenant UUID := social.image_tenant(p_name);
BEGIN
  RETURN v_tenant IS NOT NULL AND social.is_member(v_tenant);
END;
$$;

CREATE FUNCTION social.can_delete_image(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tenant UUID := social.image_tenant(p_name);
BEGIN
  RETURN v_tenant IS NOT NULL AND social.can_edit(v_tenant);
END;
$$;

CREATE POLICY social_media_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'social-media' AND social.can_read_image(name));
CREATE POLICY social_media_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'social-media' AND social.can_upload_image(name));
CREATE POLICY social_media_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'social-media' AND social.can_delete_image(name));

-- Helpers
CREATE FUNCTION social.needs_approval(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT require_approval FROM social.settings WHERE tenant_id = p_tenant), false);
$$;

-- What approval covers: the text for each account, the image, the link and the date
CREATE FUNCTION social.post_fingerprint(p_post UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT md5(concat_ws('|', p.link_url, p.scheduled_at::text, p.image_path,
    (SELECT string_agg(t.account_id::text || ':' || t.body, '|' ORDER BY t.account_id) FROM social.post_targets t WHERE t.post_id = p.id)))
  FROM social.posts p WHERE p.id = p_post;
$$;

-- In-app alerts to people still in the company, never to the person who did it
CREATE FUNCTION social.notify(p_tenant UUID, p_users UUID[], p_title TEXT, p_body TEXT, p_post UUID, p_key TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
  SELECT p_tenant, tm.user_id, left(p_title, 200), left(p_body, 500), '/saas/social?post=' || p_post, p_key
  FROM public.tenant_members tm
  WHERE tm.tenant_id = p_tenant AND tm.user_id = ANY (p_users) AND tm.user_id IS DISTINCT FROM auth.uid()
  ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
$$;

-- A post is posted once every account on it is posted, and goes back when one is undone
CREATE FUNCTION social.refresh_posted(p_post UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_total INT;
  v_done INT;
  v_last TIMESTAMP;
BEGIN
  SELECT count(*), count(posted_at), max(posted_at) INTO v_total, v_done, v_last
    FROM social.post_targets WHERE post_id = p_post;
  IF v_total > 0 AND v_total = v_done THEN
    UPDATE social.posts SET status = 'posted', posted_at = v_last, updated_at = now()
      WHERE id = p_post AND status <> 'posted';
  ELSE
    UPDATE social.posts SET status = CASE WHEN scheduled_at IS NULL THEN 'approved' ELSE 'scheduled' END,
      posted_at = NULL, updated_at = now()
      WHERE id = p_post AND status = 'posted';
  END IF;
END;
$$;

-- Settings. Owners and admins only.
CREATE FUNCTION social.save_settings(p_tenant UUID, p_require_approval BOOLEAN, p_timezone TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tz TEXT := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
  saved social.settings;
BEGIN
  IF social.role_in(p_tenant) IS DISTINCT FROM 'owner' AND social.role_in(p_tenant) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only owners and admins can change these settings';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_tz) THEN
    RAISE EXCEPTION 'Choose a valid time zone';
  END IF;
  INSERT INTO social.settings (tenant_id, require_approval, timezone, updated_at)
  VALUES (p_tenant, coalesce(p_require_approval, false), v_tz, now())
  ON CONFLICT (tenant_id) DO UPDATE SET require_approval = EXCLUDED.require_approval, timezone = EXCLUDED.timezone,
    updated_at = now()
  RETURNING * INTO saved;
  RETURN row_to_json(saved);
END;
$$;

-- Accounts. The platform can't change once listed, because post text is checked against it.
CREATE FUNCTION social.save_account(p_tenant UUID, p_account UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_platform TEXT := p_data->>'platform';
  v_handle TEXT := btrim(coalesce(p_data->>'handle', ''));
  v_url TEXT := nullif(btrim(coalesce(p_data->>'profile_url', '')), '');
  saved social.accounts;
BEGIN
  PERFORM social.require_editor(p_tenant);
  IF length(v_handle) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Enter the account name or handle, up to 100 characters';
  END IF;
  IF v_url IS NOT NULL AND NOT social.is_web_link(v_url) THEN
    RAISE EXCEPTION 'Enter the profile link starting with https://';
  END IF;
  IF p_account IS NULL THEN
    IF v_platform IS NULL OR v_platform NOT IN ('x', 'linkedin', 'facebook', 'instagram') THEN
      RAISE EXCEPTION 'Choose a platform';
    END IF;
    INSERT INTO social.accounts (tenant_id, platform, handle, profile_url, created_by)
    VALUES (p_tenant, v_platform, v_handle, v_url, auth.uid())
    RETURNING * INTO saved;
  ELSE
    UPDATE social.accounts SET handle = v_handle, profile_url = v_url,
      is_active = coalesce((p_data->>'is_active')::boolean, is_active)
      WHERE id = p_account AND tenant_id = p_tenant
      RETURNING * INTO saved;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Account not found';
    END IF;
  END IF;
  RETURN row_to_json(saved);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That account is already listed';
END;
$$;

CREATE FUNCTION social.delete_account(p_tenant UUID, p_account UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM social.require_editor(p_tenant);
  DELETE FROM social.accounts WHERE id = p_account AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
  RETURN json_build_object('success', true);
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'This account is on posts. Turn it off instead of deleting it.';
END;
$$;

-- Creates or changes a post and the accounts it goes to. When approval is on and someone other than an
-- owner or admin changes what was approved, the post goes back to draft to be approved again.
-- The image must already be uploaded to the company's folder; size and type come from the stored file.
CREATE FUNCTION social.save_post(p_tenant UUID, p_post UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT := social.require_editor(p_tenant);
  manager BOOLEAN := v_role IN ('owner', 'admin');
  approval BOOLEAN := social.needs_approval(p_tenant);
  old social.posts;
  saved social.posts;
  v_title TEXT := btrim(coalesce(p_data->>'title', ''));
  v_campaign TEXT := nullif(btrim(coalesce(p_data->>'campaign', '')), '');
  v_link TEXT := nullif(btrim(coalesce(p_data->>'link_url', '')), '');
  v_notes TEXT := nullif(btrim(coalesce(p_data->>'notes', '')), '');
  v_image TEXT := nullif(btrim(coalesce(p_data->>'image_path', '')), '');
  v_tags_in JSONB := coalesce(p_data->'tags', '[]'::jsonb);
  v_targets JSONB := coalesce(p_data->'targets', '[]'::jsonb);
  v_prefix TEXT := p_tenant::text || '/';
  v_when TIMESTAMPTZ;
  v_assignee UUID;
  v_tags TEXT[];
  v_meta JSONB;
  v_size BIGINT;
  v_mime TEXT;
  v_removed TEXT;
  v_before TEXT;
  v_reset BOOLEAN := false;
  v_target JSONB;
  v_account social.accounts;
  v_body TEXT;
  v_keep UUID[] := '{}';
BEGIN
  IF length(v_title) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Enter a name for the post, up to 200 characters';
  END IF;
  IF length(v_campaign) > 100 THEN
    RAISE EXCEPTION 'Campaign names can be up to 100 characters';
  END IF;
  IF v_link IS NOT NULL AND NOT social.is_web_link(v_link) THEN
    RAISE EXCEPTION 'Enter the link starting with https://';
  END IF;
  IF length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'Notes can be up to 2000 characters';
  END IF;
  BEGIN
    v_when := nullif(btrim(coalesce(p_data->>'scheduled_at', '')), '')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Choose a valid date and time';
  END;
  IF v_when IS NOT NULL AND (v_when < '2000-01-01' OR v_when > now() + interval '5 years') THEN
    RAISE EXCEPTION 'Choose a date within the next 5 years';
  END IF;

  IF jsonb_typeof(v_tags_in) <> 'array' OR jsonb_typeof(v_targets) <> 'array' THEN
    RAISE EXCEPTION 'Tags and accounts must be lists';
  END IF;
  SELECT coalesce(array_agg(DISTINCT tag ORDER BY tag), '{}') INTO v_tags
    FROM (SELECT lower(left(btrim(regexp_replace(value, '^#+', '')), 50)) AS tag
          FROM jsonb_array_elements_text(v_tags_in) AS value) s
    WHERE tag <> '';
  IF cardinality(v_tags) > 20 THEN
    RAISE EXCEPTION 'A post can have up to 20 tags';
  END IF;
  IF jsonb_array_length(v_targets) > 10 THEN
    RAISE EXCEPTION 'Choose up to 10 accounts';
  END IF;

  IF p_post IS NOT NULL THEN
    SELECT * INTO old FROM social.posts WHERE id = p_post AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Post not found';
    END IF;
    IF old.status = 'posted' THEN
      RAISE EXCEPTION 'This post is already out. Undo "posted" on an account first to change it.';
    END IF;
    v_before := social.post_fingerprint(p_post);
  END IF;

  IF nullif(btrim(coalesce(p_data->>'assigned_to', '')), '') IS NOT NULL THEN
    v_assignee := social.uuid_or_null(btrim(p_data->>'assigned_to'));
    IF v_assignee IS NULL OR (v_assignee IS DISTINCT FROM old.assigned_to AND NOT EXISTS (
        SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = v_assignee)) THEN
      RAISE EXCEPTION 'Choose someone in your company to look after this post';
    END IF;
  END IF;

  -- Image
  IF v_image IS NOT NULL AND v_image IS DISTINCT FROM old.image_path THEN
    IF length(v_image) > 500 OR left(v_image, length(v_prefix)) <> v_prefix OR length(v_image) = length(v_prefix)
        OR position('/' IN substr(v_image, length(v_prefix) + 1)) > 0 THEN
      RAISE EXCEPTION 'The image isn''t in the right place';
    END IF;
    SELECT metadata INTO v_meta FROM storage.objects WHERE bucket_id = 'social-media' AND name = v_image;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The image wasn''t uploaded. Please try again.';
    END IF;
    v_size := (v_meta->>'size')::bigint;
    v_mime := v_meta->>'mimetype';
    IF v_size IS NULL OR v_size <= 0 OR v_size > 5242880 THEN
      RAISE EXCEPTION 'Images can be up to 5 MB';
    END IF;
    IF v_mime IS NULL OR v_mime NOT IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp') THEN
      RAISE EXCEPTION 'Upload a JPEG, PNG, GIF or WebP image';
    END IF;
    IF EXISTS (SELECT 1 FROM social.posts WHERE image_path = v_image) THEN
      RAISE EXCEPTION 'That image is already on another post';
    END IF;
    -- One company adds one image at a time, so the space check can't be raced
    PERFORM pg_advisory_xact_lock(hashtextextended('social.images:' || p_tenant::text, 0));
    IF social.image_space_used(p_tenant) > 104857600 THEN
      RAISE EXCEPTION 'Your company has used its 100 MB of image space. Remove images from old posts to make room.';
    END IF;
  ELSIF v_image IS NOT NULL THEN
    v_size := old.image_size;
    v_mime := old.image_mime;
  END IF;
  IF old.image_path IS NOT NULL AND v_image IS DISTINCT FROM old.image_path THEN
    v_removed := old.image_path;
  END IF;

  IF p_post IS NULL THEN
    INSERT INTO social.posts (tenant_id, title, campaign, tags, link_url, scheduled_at, status, assigned_to,
      image_path, image_size, image_mime, notes, created_by)
    VALUES (p_tenant, v_title, v_campaign, v_tags, v_link, v_when, 'draft', v_assignee,
      v_image, v_size, v_mime, v_notes, auth.uid())
    RETURNING * INTO saved;
  ELSE
    UPDATE social.posts SET title = v_title, campaign = v_campaign, tags = v_tags, link_url = v_link,
      scheduled_at = v_when, assigned_to = v_assignee, image_path = v_image, image_size = v_size,
      image_mime = v_mime, notes = v_notes, updated_at = now(),
      status = CASE WHEN status IN ('approved', 'scheduled')
        THEN CASE WHEN v_when IS NULL THEN 'approved' ELSE 'scheduled' END ELSE status END
      WHERE id = p_post
      RETURNING * INTO saved;
  END IF;

  -- Accounts and their text. Accounts left out are removed from the post.
  FOR v_target IN SELECT value FROM jsonb_array_elements(v_targets) LOOP
    SELECT * INTO v_account FROM social.accounts
      WHERE id = social.uuid_or_null(v_target->>'account_id') AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Account not found';
    END IF;
    IF v_account.id = ANY (v_keep) THEN
      RAISE EXCEPTION 'Each account can be chosen once';
    END IF;
    IF NOT v_account.is_active AND NOT EXISTS (
        SELECT 1 FROM social.post_targets WHERE post_id = saved.id AND account_id = v_account.id) THEN
      RAISE EXCEPTION '% is turned off. Turn it on under Accounts to post to it.', v_account.handle;
    END IF;
    v_body := coalesce(v_target->>'body', '');
    IF char_length(v_body) > social.char_limit(v_account.platform) THEN
      RAISE EXCEPTION 'The text for % is % characters. % allows %.', v_account.handle, char_length(v_body),
        social.platform_name(v_account.platform), social.char_limit(v_account.platform);
    END IF;
    INSERT INTO social.post_targets (tenant_id, post_id, account_id, platform, body)
    VALUES (p_tenant, saved.id, v_account.id, v_account.platform, v_body)
    ON CONFLICT (post_id, account_id) DO UPDATE SET body = EXCLUDED.body;
    v_keep := v_keep || v_account.id;
  END LOOP;
  DELETE FROM social.post_targets WHERE post_id = saved.id AND NOT (account_id = ANY (v_keep));

  IF p_post IS NOT NULL THEN
    IF approval AND NOT manager AND saved.status IN ('approved', 'scheduled')
        AND v_before IS DISTINCT FROM social.post_fingerprint(saved.id) THEN
      UPDATE social.posts SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = saved.id;
      v_reset := true;
    END IF;
    PERFORM social.refresh_posted(saved.id);
  END IF;

  IF v_assignee IS NOT NULL AND v_assignee IS DISTINCT FROM old.assigned_to THEN
    PERFORM social.notify(p_tenant, ARRAY[v_assignee], 'A post was given to you: ' || v_title,
      CASE WHEN v_when IS NULL THEN 'No date yet' ELSE 'Planned for ' || to_char(v_when AT TIME ZONE coalesce(
        (SELECT timezone FROM social.settings WHERE tenant_id = p_tenant), 'UTC'), 'FMDD Mon YYYY, HH24:MI') END,
      saved.id, 'social:' || saved.id || ':assigned:' || v_assignee || ':' || extract(epoch FROM clock_timestamp())::bigint);
  END IF;

  SELECT * INTO saved FROM social.posts WHERE id = saved.id;
  RETURN json_build_object('post', row_to_json(saved), 'removed_image', v_removed, 'approval_reset', v_reset);
END;
$$;

-- Sends a draft on: for approval when the company asks for it (unless an owner or admin sends it),
-- otherwise straight to scheduled, or approved when it has no date yet.
CREATE FUNCTION social.submit_post(p_tenant UUID, p_post UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT := social.require_editor(p_tenant);
  manager BOOLEAN := v_role IN ('owner', 'admin');
  approval BOOLEAN := social.needs_approval(p_tenant);
  post social.posts;
BEGIN
  SELECT * INTO post FROM social.posts WHERE id = p_post AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found';
  END IF;
  IF post.status NOT IN ('draft', 'needs_approval') THEN
    RAISE EXCEPTION 'This post has already been approved or scheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM social.post_targets WHERE post_id = p_post) THEN
    RAISE EXCEPTION 'Choose at least one account to post to';
  END IF;
  IF post.image_path IS NULL AND EXISTS (SELECT 1 FROM social.post_targets WHERE post_id = p_post AND btrim(body) = '') THEN
    RAISE EXCEPTION 'Write the text for each account, or add an image';
  END IF;
  IF EXISTS (SELECT 1 FROM social.post_targets WHERE post_id = p_post AND platform = 'instagram') AND post.image_path IS NULL THEN
    RAISE EXCEPTION 'Instagram posts need an image';
  END IF;

  IF approval AND NOT manager THEN
    IF post.status = 'needs_approval' THEN
      RAISE EXCEPTION 'This post is already waiting for approval';
    END IF;
    UPDATE social.posts SET status = 'needs_approval', submitted_by = auth.uid(), submitted_at = now(),
      review_note = NULL, updated_at = now()
      WHERE id = p_post RETURNING * INTO post;
    PERFORM social.notify(p_tenant, ARRAY(SELECT user_id FROM public.tenant_members
        WHERE tenant_id = p_tenant AND role IN ('owner', 'admin')),
      'Post waiting for approval: ' || post.title,
      CASE WHEN post.scheduled_at IS NULL THEN 'No date yet' ELSE 'Planned for ' || to_char(post.scheduled_at AT TIME ZONE
        coalesce((SELECT timezone FROM social.settings WHERE tenant_id = p_tenant), 'UTC'), 'FMDD Mon YYYY, HH24:MI') END,
      p_post, 'social:' || p_post || ':submitted:' || extract(epoch FROM post.submitted_at)::bigint);
  ELSE
    UPDATE social.posts SET status = CASE WHEN scheduled_at IS NULL THEN 'approved' ELSE 'scheduled' END,
      submitted_by = auth.uid(), submitted_at = now(),
      approved_by = CASE WHEN approval THEN auth.uid() END, approved_at = CASE WHEN approval THEN now() END,
      updated_at = now()
      WHERE id = p_post RETURNING * INTO post;
  END IF;
  RETURN row_to_json(post);
END;
$$;

-- Owners and admins approve, or send back to draft with a note
CREATE FUNCTION social.decide_post(p_tenant UUID, p_post UUID, p_approve BOOLEAN, p_note TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_note TEXT := nullif(btrim(coalesce(p_note, '')), '');
  post social.posts;
BEGIN
  IF social.role_in(p_tenant) IS DISTINCT FROM 'owner' AND social.role_in(p_tenant) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only owners and admins can approve posts';
  END IF;
  IF length(v_note) > 500 THEN
    RAISE EXCEPTION 'Notes can be up to 500 characters';
  END IF;
  SELECT * INTO post FROM social.posts WHERE id = p_post AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found';
  END IF;
  IF post.status <> 'needs_approval' THEN
    RAISE EXCEPTION 'This post isn''t waiting for approval';
  END IF;
  IF coalesce(p_approve, false) THEN
    UPDATE social.posts SET status = CASE WHEN scheduled_at IS NULL THEN 'approved' ELSE 'scheduled' END,
      approved_by = auth.uid(), approved_at = now(), review_note = v_note, updated_at = now()
      WHERE id = p_post RETURNING * INTO post;
  ELSE
    UPDATE social.posts SET status = 'draft', approved_by = NULL, approved_at = NULL, review_note = v_note, updated_at = now()
      WHERE id = p_post RETURNING * INTO post;
  END IF;
  PERFORM social.notify(p_tenant, ARRAY[post.submitted_by, post.created_by, post.assigned_to],
    CASE WHEN p_approve THEN 'Post approved: ' ELSE 'Post needs changes: ' END || post.title,
    coalesce('Note: ' || v_note, CASE WHEN p_approve THEN 'It''s ready to go out.' ELSE 'It''s back in draft.' END),
    p_post, 'social:' || p_post || ':' || CASE WHEN p_approve THEN 'approved' ELSE 'returned' END || ':'
      || extract(epoch FROM clock_timestamp())::bigint);
  RETURN row_to_json(post);
END;
$$;

-- Takes a post back to draft, for example to stop it going out
CREATE FUNCTION social.to_draft(p_tenant UUID, p_post UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  post social.posts;
BEGIN
  PERFORM social.require_editor(p_tenant);
  UPDATE social.posts SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = now()
    WHERE id = p_post AND tenant_id = p_tenant AND status IN ('needs_approval', 'approved', 'scheduled')
    RETURNING * INTO post;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only posts that aren''t out yet can go back to draft';
  END IF;
  RETURN row_to_json(post);
END;
$$;

-- Records that someone posted to one account from the platform, with the live link
CREATE FUNCTION social.mark_posted(p_tenant UUID, p_target UUID, p_url TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_url TEXT := btrim(coalesce(p_url, ''));
  post social.posts;
  v_post UUID;
BEGIN
  PERFORM social.require_editor(p_tenant);
  SELECT post_id INTO v_post FROM social.post_targets WHERE id = p_target AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  SELECT * INTO post FROM social.posts WHERE id = v_post FOR UPDATE;
  IF social.needs_approval(p_tenant) AND post.status IN ('draft', 'needs_approval') THEN
    RAISE EXCEPTION 'This post needs approval before it goes out';
  END IF;
  IF NOT social.is_web_link(v_url) THEN
    RAISE EXCEPTION 'Paste the link to the live post, starting with https://';
  END IF;
  UPDATE social.post_targets SET posted_at = now(), post_url = v_url, posted_by = auth.uid() WHERE id = p_target;
  PERFORM social.refresh_posted(v_post);
  SELECT * INTO post FROM social.posts WHERE id = v_post;
  RETURN row_to_json(post);
END;
$$;

CREATE FUNCTION social.unmark_posted(p_tenant UUID, p_target UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  post social.posts;
  v_post UUID;
BEGIN
  PERFORM social.require_editor(p_tenant);
  UPDATE social.post_targets SET posted_at = NULL, post_url = NULL, posted_by = NULL
    WHERE id = p_target AND tenant_id = p_tenant RETURNING post_id INTO v_post;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  PERFORM social.refresh_posted(v_post);
  SELECT * INTO post FROM social.posts WHERE id = v_post;
  RETURN row_to_json(post);
END;
$$;

-- Removes the post. The app deletes its image through the Storage API, because Supabase doesn't allow
-- deleting storage objects with SQL.
CREATE FUNCTION social.delete_post(p_tenant UUID, p_post UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_image TEXT;
BEGIN
  PERFORM social.require_editor(p_tenant);
  DELETE FROM social.posts WHERE id = p_post AND tenant_id = p_tenant RETURNING image_path INTO v_image;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found';
  END IF;
  RETURN json_build_object('success', true, 'removed_image', v_image);
END;
$$;

-- Alerts the person looking after each scheduled post (or whoever made it) on its day in the company's
-- time zone, once per date it's planned for. Posts that are late and never alerted are alerted too.
CREATE FUNCTION social.alert_due(p_tenant UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tz TEXT := coalesce((SELECT timezone FROM social.settings WHERE tenant_id = p_tenant), 'UTC');
  v_today DATE := (now() AT TIME ZONE tz)::date;
  v_count INT;
BEGIN
  WITH sent AS (
    INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT p.tenant_id, tm.user_id,
      left(CASE WHEN (p.scheduled_at AT TIME ZONE tz)::date < v_today THEN 'Post is late: ' ELSE 'Post due today: ' END
        || p.title, 200),
      left('Planned for ' || to_char(p.scheduled_at AT TIME ZONE tz, 'FMDD Mon, HH24:MI') || ' on ' ||
        coalesce((SELECT string_agg(DISTINCT social.platform_name(t.platform), ', ') FROM social.post_targets t
          WHERE t.post_id = p.id AND t.posted_at IS NULL), 'its accounts') ||
        '. Post it from the platform, then mark it as posted.', 500),
      '/saas/social?post=' || p.id,
      'social:' || p.id || ':due:' || extract(epoch FROM p.scheduled_at)::bigint
    FROM social.posts p
    JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.user_id = coalesce(p.assigned_to, p.created_by)
    WHERE p.tenant_id = p_tenant AND p.status = 'scheduled' AND (p.scheduled_at AT TIME ZONE tz)::date <= v_today
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM sent;
  RETURN v_count;
END;
$$;

-- Run when the planner opens, for the company being looked at
CREATE FUNCTION social.check_due(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT social.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN json_build_object('alerts', social.alert_due(p_tenant));
END;
$$;

-- For a scheduled job: every company at once. Not callable by signed-in users.
CREATE FUNCTION social.send_due_alerts()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tenant UUID;
  v_total INT := 0;
BEGIN
  FOR v_tenant IN SELECT DISTINCT tenant_id FROM social.posts WHERE status = 'scheduled' AND scheduled_at <= now() + interval '1 day' LOOP
    v_total := v_total + social.alert_due(v_tenant);
  END LOOP;
  RETURN v_total;
END;
$$;

-- What the planner needs to start: role, settings, people to assign, counts, filters and image space
CREATE FUNCTION social.overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT := social.role_in(p_tenant);
  s social.settings;
BEGIN
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  SELECT * INTO s FROM social.settings WHERE tenant_id = p_tenant;
  RETURN json_build_object(
    'role', v_role,
    'is_manager', v_role IN ('owner', 'admin'),
    'can_edit', v_role <> 'viewer',
    'require_approval', coalesce(s.require_approval, false),
    'timezone', coalesce(s.timezone, 'UTC'),
    'members', coalesce((
      SELECT json_agg(json_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role) ORDER BY u.email)
      FROM public.tenant_members m JOIN auth.users u ON u.id = m.user_id WHERE m.tenant_id = p_tenant), '[]'::json),
    'counts', coalesce((
      SELECT json_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM social.posts
        WHERE tenant_id = p_tenant GROUP BY status) c), '{}'::json),
    'campaigns', coalesce((
      SELECT json_agg(campaign ORDER BY lower(campaign)) FROM (SELECT DISTINCT campaign FROM social.posts
        WHERE tenant_id = p_tenant AND campaign IS NOT NULL) c), '[]'::json),
    'tags', coalesce((
      SELECT json_agg(tag ORDER BY tag) FROM (SELECT DISTINCT unnest(tags) AS tag FROM social.posts
        WHERE tenant_id = p_tenant) t), '[]'::json),
    'space_used', social.image_space_used(p_tenant),
    'space_limit', 104857600
  );
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Used only inside other functions and checks, never called directly
  FOREACH fn IN ARRAY ARRAY['social.role_in(uuid)', 'social.require_editor(uuid)', 'social.char_limit(text)',
      'social.platform_name(text)', 'social.is_web_link(text)', 'social.image_space_used(uuid)',
      'social.needs_approval(uuid)', 'social.post_fingerprint(uuid)',
      'social.notify(uuid, uuid[], text, text, uuid, text)', 'social.refresh_posted(uuid)',
      'social.alert_due(uuid)', 'social.send_due_alerts()']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  -- Policies and the app call these as the signed-in user; each checks the person's role itself
  FOREACH fn IN ARRAY ARRAY['social.is_member(uuid)', 'social.can_edit(uuid)', 'social.uuid_or_null(text)',
      'social.image_tenant(text)', 'social.can_upload_image(text)', 'social.can_read_image(text)',
      'social.can_delete_image(text)', 'social.save_settings(uuid, boolean, text)',
      'social.save_account(uuid, uuid, jsonb)', 'social.delete_account(uuid, uuid)',
      'social.save_post(uuid, uuid, jsonb)', 'social.submit_post(uuid, uuid)',
      'social.decide_post(uuid, uuid, boolean, text)', 'social.to_draft(uuid, uuid)',
      'social.mark_posted(uuid, uuid, text)', 'social.unmark_posted(uuid, uuid)', 'social.delete_post(uuid, uuid)',
      'social.check_due(uuid)', 'social.overview(uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END;
$$;

-- Add the schema to the API, keeping every schema already listed (other products add theirs too)
DO $$
DECLARE
  current_list TEXT;
BEGIN
  SELECT substr(c, length('pgrst.db_schemas=') + 1) INTO current_list
    FROM pg_roles r, unnest(r.rolconfig) AS c
    WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%';
  current_list := coalesce(nullif(btrim(current_list), ''), 'public, graphql_public');
  IF NOT ('social' = ANY (string_to_array(replace(current_list, ' ', ''), ','))) THEN
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', current_list || ', social');
  END IF;
END;
$$;

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
