-- Documents on staff records: contracts, IDs, certificates.
-- Files live in the private 'hr-documents' bucket at '<tenant_id>/<employee_id>/<uuid>-<file name>'.
-- Owners and admins upload and delete; the employee themself can read their own.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('hr-documents', 'hr-documents', false, 5242880, ARRAY[
  'application/pdf', 'image/jpeg', 'image/png', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT (id) DO NOTHING;

CREATE TABLE hr.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr.employees(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('contract', 'id', 'certificate', 'other')),
  storage_path TEXT NOT NULL UNIQUE CHECK (length(storage_path) <= 500),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  mime_type TEXT NOT NULL,
  uploaded_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_hr_documents_employee ON hr.documents (employee_id);
CREATE INDEX idx_hr_documents_tenant ON hr.documents (tenant_id);
CREATE INDEX idx_hr_documents_uploaded_by ON hr.documents (uploaded_by);
ALTER TABLE hr.documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.documents FOR SELECT TO authenticated
  USING (hr.is_manager(tenant_id) OR EXISTS (
    SELECT 1 FROM hr.employees e
    WHERE e.id = employee_id AND e.tenant_id = documents.tenant_id AND e.user_id = (SELECT auth.uid())));
GRANT SELECT ON hr.documents TO authenticated;

-- A path segment that isn't a uuid gives null instead of an error
CREATE FUNCTION hr.uuid_or_null(p_value TEXT)
RETURNS UUID
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_value::uuid END;
$$;

-- Bytes stored for a company in the bucket, including files not yet added to a record
CREATE FUNCTION hr.document_space_used(p_tenant UUID)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(sum(coalesce((metadata->>'size')::bigint, 0)), 0)::bigint FROM storage.objects
  WHERE bucket_id = 'hr-documents' AND name LIKE p_tenant::text || '/%';
$$;

-- Storage checks. The path must be exactly '<tenant>/<employee>/<file>'.
CREATE FUNCTION hr.can_upload_document_file(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  folders TEXT[] := storage.foldername(p_name);
  v_tenant UUID := hr.uuid_or_null(folders[1]);
  v_employee UUID := hr.uuid_or_null(folders[2]);
BEGIN
  IF coalesce(array_length(folders, 1), 0) <> 2 OR v_tenant IS NULL OR v_employee IS NULL THEN
    RETURN false;
  END IF;
  RETURN hr.is_manager(v_tenant)
    AND EXISTS (SELECT 1 FROM hr.employees WHERE id = v_employee AND tenant_id = v_tenant)
    AND hr.document_space_used(v_tenant) < 209715200;
END;
$$;

CREATE FUNCTION hr.can_read_document_file(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  folders TEXT[] := storage.foldername(p_name);
  v_tenant UUID := hr.uuid_or_null(folders[1]);
  v_employee UUID := hr.uuid_or_null(folders[2]);
BEGIN
  IF v_tenant IS NULL THEN
    RETURN false;
  END IF;
  RETURN hr.is_manager(v_tenant) OR (v_employee IS NOT NULL AND EXISTS (
    SELECT 1 FROM hr.employees e
    JOIN public.tenant_members tm ON tm.tenant_id = e.tenant_id AND tm.user_id = e.user_id
    WHERE e.id = v_employee AND e.tenant_id = v_tenant AND e.user_id = auth.uid()));
END;
$$;

CREATE FUNCTION hr.can_delete_document_file(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tenant UUID := hr.uuid_or_null((storage.foldername(p_name))[1]);
BEGIN
  RETURN v_tenant IS NOT NULL AND hr.is_manager(v_tenant);
END;
$$;

CREATE POLICY hr_documents_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'hr-documents' AND hr.can_read_document_file(name));
CREATE POLICY hr_documents_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'hr-documents' AND hr.can_upload_document_file(name));
CREATE POLICY hr_documents_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'hr-documents' AND hr.can_delete_document_file(name));

-- Records a file already uploaded to the bucket. Size and type come from the stored file.
CREATE FUNCTION hr.add_document(
  p_tenant UUID, p_employee UUID, p_name TEXT, p_kind TEXT, p_path TEXT, p_size BIGINT, p_mime TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_name TEXT := btrim(coalesce(p_name, ''));
  v_prefix TEXT := p_tenant::text || '/' || p_employee::text || '/';
  v_meta JSONB;
  v_size BIGINT;
  v_mime TEXT;
  v_used BIGINT;
  doc hr.documents;
BEGIN
  IF NOT hr.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'Only owners and admins can add documents';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF length(v_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Enter a name of up to 200 characters';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('contract', 'id', 'certificate', 'other') THEN
    RAISE EXCEPTION 'Choose a type of document';
  END IF;
  IF p_path IS NULL OR length(p_path) > 500 OR left(p_path, length(v_prefix)) <> v_prefix
      OR length(p_path) = length(v_prefix) OR position('/' IN substr(p_path, length(v_prefix) + 1)) > 0 THEN
    RAISE EXCEPTION 'The file isn''t in the right place';
  END IF;

  SELECT metadata INTO v_meta FROM storage.objects WHERE bucket_id = 'hr-documents' AND name = p_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The file wasn''t uploaded. Please try again.';
  END IF;
  v_size := coalesce((v_meta->>'size')::bigint, p_size);
  v_mime := coalesce(v_meta->>'mimetype', p_mime);
  IF v_size IS NULL OR v_size <= 0 OR v_size > 5242880 THEN
    RAISE EXCEPTION 'Files can be up to 5 MB';
  END IF;
  IF v_mime IS NULL OR v_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document') THEN
    RAISE EXCEPTION 'Upload a PDF, JPEG, PNG or Word file';
  END IF;

  -- One company adds one document at a time, so the space check can't be raced
  PERFORM pg_advisory_xact_lock(hashtextextended('hr.documents:' || p_tenant::text, 0));
  SELECT coalesce(sum(size_bytes), 0) INTO v_used FROM hr.documents WHERE tenant_id = p_tenant;
  IF v_used + v_size > 209715200 THEN
    RAISE EXCEPTION 'Your company has used its 200 MB of document space. Delete old documents to make room.';
  END IF;

  INSERT INTO hr.documents (tenant_id, employee_id, name, kind, storage_path, size_bytes, mime_type, uploaded_by)
  VALUES (p_tenant, p_employee, v_name, p_kind, p_path, v_size, v_mime, auth.uid())
  RETURNING * INTO doc;
  RETURN row_to_json(doc);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That file has already been added';
END;
$$;

-- Removes the record. The app deletes the file through the Storage API first,
-- because Supabase doesn't allow deleting storage objects with SQL.
CREATE FUNCTION hr.delete_document(p_tenant UUID, p_document UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_path TEXT;
BEGIN
  IF NOT hr.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'Only owners and admins can delete documents';
  END IF;
  DELETE FROM hr.documents WHERE id = p_document AND tenant_id = p_tenant RETURNING storage_path INTO v_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found';
  END IF;
  RETURN json_build_object('success', true, 'storage_path', v_path);
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Used only inside the checks above
  EXECUTE 'REVOKE EXECUTE ON FUNCTION hr.document_space_used(uuid) FROM PUBLIC, anon, authenticated';
  -- Storage policies run these as the signed-in user, so they need to be callable
  FOREACH fn IN ARRAY ARRAY['hr.uuid_or_null(text)', 'hr.can_upload_document_file(text)',
      'hr.can_read_document_file(text)', 'hr.can_delete_document_file(text)',
      'hr.add_document(uuid, uuid, text, text, text, bigint, text)', 'hr.delete_document(uuid, uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
