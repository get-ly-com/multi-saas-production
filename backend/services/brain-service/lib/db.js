// Database access. Two kinds of client:
//  - asUser(authorization): the signed-in person's own token, so the database checks who they are
//    and what they may do (listing ideas, deciding on them).
//  - service(): the service role, for the Brain's own work without a person (thinking, recording
//    runs, the daily job, the MCP server). It only calls the brain.* and integrations.* functions
//    the migration grants to the service role; it reads no business tables directly.
const { createClient } = require('@supabase/supabase-js');
const { userError } = require('./business');

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

let serviceClient = null;
const service = () => {
  if (!serviceClient) {
    if (!process.env.SUPABASE_URL || !serviceKey()) {
      throw userError('The Business Brain isn’t set up on this server yet.', 503);
    }
    serviceClient = createClient(process.env.SUPABASE_URL, serviceKey(), options);
  }
  return serviceClient;
};

const asUser = (authorization) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw userError('The Business Brain isn’t set up on this server yet.', 503);
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    ...options,
    global: { headers: { Authorization: authorization } }
  });
};

// Runs a database function and returns its data, or throws its error
const rpc = async (client, schema, name, params = {}) => {
  const { data, error, status } = await client.schema(schema).rpc(name, params);
  if (error) throw Object.assign(error, { httpStatus: status });
  return data;
};

const brainAs = (authorization) => (name, params) => rpc(asUser(authorization), 'brain', name, params);
const brainService = (name, params) => rpc(service(), 'brain', name, params);
const integrations = (name, params) => rpc(service(), 'integrations', name, params);

// Facts are read at most once a minute per company, so a burst of MCP calls costs one query
const FACTS_TTL = 60 * 1000;
const factsCache = new Map();
const companyFacts = async (tenantId, { fresh = false } = {}) => {
  const cached = factsCache.get(tenantId);
  if (!fresh && cached && Date.now() - cached.at < FACTS_TTL) return cached.facts;
  const facts = await brainService('company_facts', { p_tenant: tenantId });
  if (factsCache.size > 500) factsCache.clear();
  factsCache.set(tenantId, { at: Date.now(), facts });
  return facts;
};

// analytics.dashboard / analytics.compare for the whole company (as its owner sees it)
const companyNumbers = (tenantId) => (name, params) =>
  brainService('company_numbers', { p_tenant: tenantId, p_kind: name, p_from: params.p_from, p_to: params.p_to });

module.exports = { service, asUser, rpc, brainAs, brainService, integrations, companyFacts, companyNumbers };
