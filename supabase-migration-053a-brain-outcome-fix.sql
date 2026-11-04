-- Business Brain fix: brain.record_outcome named its row variable "found", which hid PL/pgSQL's
-- FOUND flag, so recording an outcome failed. It now counts the inserted row instead.

CREATE OR REPLACE FUNCTION brain.record_outcome(p_proposal UUID, p_metric TEXT, p_baseline NUMERIC, p_value NUMERIC,
  p_verdict TEXT, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  prop brain.proposals;
  added INT;
BEGIN
  SELECT * INTO prop FROM brain.proposals p WHERE p.id = p_proposal;
  IF prop.id IS NULL THEN
    RAISE EXCEPTION 'Idea not found';
  END IF;
  INSERT INTO brain.outcomes (tenant_id, proposal_id, metric, baseline, value, verdict, note)
    VALUES (prop.tenant_id, prop.id, left(p_metric, 60), p_baseline, p_value, p_verdict, left(p_note, 1000))
    ON CONFLICT (proposal_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  IF added > 0 THEN
    PERFORM brain.learn(prop.tenant_id, prop.category, p_verdict, prop.title, NULL, NULL);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION brain.record_outcome(uuid, text, numeric, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION brain.record_outcome(uuid, text, numeric, numeric, text, text) TO service_role;
