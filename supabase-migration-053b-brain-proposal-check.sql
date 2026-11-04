-- Business Brain: an idea's JSON now includes how it will be checked (check_spec), so brain-service
-- can take the starting number when the idea is carried out.

CREATE OR REPLACE FUNCTION brain.proposal_json(p brain.proposals)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'id', p.id, 'title', p.title, 'category', p.category, 'summary', p.summary,
    'evidence', p.evidence, 'pros', p.pros, 'cons', p.cons, 'risks', p.risks,
    'expected_impact', p.expected_impact, 'effort', p.effort, 'actions', p.actions,
    'source', p.source, 'status', p.status,
    'decided_by', p.decided_by, 'decided_at', p.decided_at, 'decision_note', p.decision_note,
    'created_at', p.created_at, 'expires_at', p.expires_at, 'executed_at', p.executed_at,
    'check_at', p.check_at, 'check_spec', p.check_spec, 'result_summary', p.result_summary,
    'runs', (SELECT coalesce(json_agg(json_build_object('position', r.position, 'action', r.action, 'status', r.status,
        'result', r.result, 'error', r.error, 'at', r.created_at) ORDER BY r.position, r.created_at), '[]'::json)
      FROM brain.action_runs r WHERE r.proposal_id = p.id),
    'outcome', (SELECT json_build_object('metric', o.metric, 'baseline', o.baseline, 'value', o.value,
        'verdict', o.verdict, 'note', o.note, 'measured_at', o.measured_at)
      FROM brain.outcomes o WHERE o.proposal_id = p.id)
  );
$$;

REVOKE EXECUTE ON FUNCTION brain.proposal_json(brain.proposals) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION brain.proposal_json(brain.proposals) TO service_role;
