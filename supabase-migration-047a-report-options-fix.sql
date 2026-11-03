-- report_options reads the dataset definitions, which signed-in users can't call directly, so it
-- runs as its owner. It returns only labels and keys, never the SQL pieces.
CREATE OR REPLACE FUNCTION analytics.report_options()
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_agg(json_build_object(
    'key', d.name,
    'label', def->>'label',
    'dates', (SELECT jsonb_agg(e - 'expr' ORDER BY n) FROM jsonb_array_elements(def->'dates') WITH ORDINALITY AS a(e, n)),
    'groups', (SELECT jsonb_agg(e - 'expr' ORDER BY n) FROM jsonb_array_elements(def->'groups') WITH ORDINALITY AS a(e, n)),
    'measures', (SELECT jsonb_agg(e - 'expr' ORDER BY n) FROM jsonb_array_elements(def->'measures') WITH ORDINALITY AS a(e, n)),
    'filters', (SELECT jsonb_agg(e - 'where' ORDER BY n) FROM jsonb_array_elements(def->'filters') WITH ORDINALITY AS a(e, n))
  ) ORDER BY d.n)
  FROM unnest(analytics.report_datasets()) WITH ORDINALITY AS d(name, n),
    LATERAL (SELECT analytics.report_def(d.name) AS def) x;
$$;
REVOKE EXECUTE ON FUNCTION analytics.report_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION analytics.report_options() TO authenticated;
