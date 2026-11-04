// Deciding on ideas and carrying out approved ones, then checking later whether they worked.
//
// The decision is made by the database (brain.decide) as the signed-in person, so only owners and
// admins can approve. Each action then runs through the gateway as that same person.

const { brainAs, brainService } = require('./db');
const { CATALOG } = require('./catalog');
const { METRICS, verdictFor } = require('./ideas');
const { plural, userError } = require('./business');

const DAY = 24 * 60 * 60 * 1000;

const decide = async (ctx, proposalId, decision, note) => {
  // Make sure it belongs to the company the person is working in
  await brainAs(ctx.authorization)('get_proposal', { p_tenant: ctx.tenantId, p_proposal: proposalId });
  return brainAs(ctx.authorization)('decide', { p_proposal: proposalId, p_decision: decision, p_note: note || null });
};

// Carries out an approved idea. Returns the finished idea and a plain account of each step.
const carryOut = async (ctx, approved) => {
  const started = await brainService('start_run', { p_tenant: ctx.tenantId, p_proposal: approved.id });
  const runCtx = { ...ctx, userId: approved.decided_by };
  const results = [];

  for (const [position, action] of (started.actions || []).entries()) {
    const entry = CATALOG[action.type];
    let status = 'done';
    let result = null;
    let error = null;
    try {
      if (!entry) throw new Error('This step is no longer something the Brain can do.');
      const params = entry.check(action.params || {});
      result = await entry.run(runCtx, params);
    } catch (problem) {
      status = 'failed';
      error = String(problem?.message || 'That step didn’t work.').slice(0, 1000);
    }
    await brainService('record_run', {
      p_tenant: ctx.tenantId, p_proposal: approved.id, p_position: position, p_action: action.type,
      p_params: action.params || {}, p_status: status, p_result: result, p_error: error, p_user: approved.decided_by
    }).catch((problem) => console.error('Brain run not recorded:', problem?.message));
    results.push({
      action: action.type,
      label: entry?.label || action.label || action.type,
      status,
      message: status === 'done' ? result?.message : `Didn’t work: ${error}`,
      link: result?.link || null,
      whatsapp_link: result?.whatsapp_link || null
    });
  }

  const failed = results.filter((r) => r.status === 'failed').length;
  const done = results.length - failed;
  const status = failed ? 'failed' : 'done';
  const summary = !results.length
    ? 'Approved as advice. There was nothing for the Brain to do in the app.'
    : failed
      ? `${done} of ${plural(results.length, 'step')} worked. ${results.filter((r) => r.status === 'failed').map((r) => `${r.label}: ${r.message.replace(/^Didn’t work: /, '')}`).join(' ')}`
      : results.map((r) => r.message).join(' ');

  // When to check whether it worked, and the number to compare against
  let checkAt = null;
  let checkSpec = started.check_spec || null;
  const metric = checkSpec?.kind || started.expected_impact?.metric;
  if (status === 'done' && metric && METRICS[metric]?.better) {
    checkSpec = { ...(checkSpec || {}), kind: metric, since: new Date().toISOString() };
    try {
      checkSpec.baseline = Number(await brainService('measure', { p_tenant: ctx.tenantId, p_spec: checkSpec }));
      const days = Math.min(Math.max(Number(started.expected_impact?.timeframe_days) || 30, 1), 180);
      checkAt = new Date(Date.now() + days * DAY).toISOString();
    } catch (problem) {
      console.error('Brain baseline not measured:', problem?.message);
      checkSpec = started.check_spec || null;
    }
  }

  const finished = await brainService('finish_proposal', {
    p_tenant: ctx.tenantId, p_proposal: approved.id, p_status: status, p_summary: summary,
    p_check_at: checkAt, p_check_spec: checkSpec
  });
  return {
    proposal: finished,
    results,
    message: status === 'done'
      ? (results.length ? `Done. ${summary}` : summary)
      : `Some steps didn’t work. ${summary}`
  };
};

const approve = async (ctx, proposalId, note) => {
  const asUser = brainAs(ctx.authorization);
  const current = await asUser('get_proposal', { p_tenant: ctx.tenantId, p_proposal: proposalId });
  // Approved before but not carried out (the service stopped half way): an owner or admin can
  // carry it out now without deciding again
  if (current.status === 'approved') {
    const role = await asUser('role_in', { p_tenant: ctx.tenantId });
    if (!['owner', 'admin'].includes(role)) throw userError('Only owners and admins can decide on ideas', 403);
    return carryOut(ctx, current);
  }
  const approved = await asUser('decide', { p_proposal: proposalId, p_decision: 'approve', p_note: note || null });
  return carryOut(ctx, approved);
};

// The daily check: re-measure each carried-out idea whose check date has come
const checkOutcomes = async () => {
  const due = await brainService('due_checks', { p_limit: 200 });
  let checked = 0;
  let failed = 0;
  for (const item of due || []) {
    try {
      const spec = item.check_spec || {};
      const metric = spec.kind;
      const rule = METRICS[metric];
      if (!rule?.better) continue;
      const value = Number(await brainService('measure', { p_tenant: item.tenant_id, p_spec: spec }));
      const baseline = spec.baseline === undefined ? null : Number(spec.baseline);
      const verdict = verdictFor(metric, baseline, value, item.expected_impact?.amount) || 'didnt';
      const note = baseline === null
        ? `Measured ${rule.label}: ${value}.`
        : `${rule.label[0].toUpperCase()}${rule.label.slice(1)} went from ${baseline} to ${value}.`;
      await brainService('record_outcome', {
        p_proposal: item.id, p_metric: metric, p_baseline: baseline, p_value: value, p_verdict: verdict, p_note: note
      });
      checked += 1;
    } catch (error) {
      failed += 1;
      console.error('Brain outcome check failed:', error?.message);
    }
  }
  return { due: (due || []).length, checked, failed };
};

module.exports = { decide, approve, carryOut, checkOutcomes };
