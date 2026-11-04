/* eslint-env jest */
'use strict';

// Runs offline: the get-ly API is stood in for by nock, so no real key or address is needed.
// Run with: npm install && npm test

const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');

const appTester = zapier.createAppTester(App);
const API = 'https://api.getly.test';
const GOOD_KEY = `gk_${'a1'.repeat(24)}`;

describe('authentication', () => {
  beforeAll(() => {
    process.env.GETLY_API_URL = API;
    nock.disableNetConnect();
  });

  afterEach(() => nock.cleanAll());

  afterAll(() => nock.enableNetConnect());

  it('accepts a working key and sends it as a Bearer token', async () => {
    const scope = nock(API, { reqheaders: { authorization: `Bearer ${GOOD_KEY}` } })
      .get('/api/v1/contacts')
      .query({ limit: '1', offset: '0' })
      .reply(200, { object: 'list', resource: 'contacts', data: [], limit: 1, offset: 0, has_more: false, next_offset: null });

    const bundle = { authData: { api_key: GOOD_KEY } };
    const result = await appTester(App.authentication.test, bundle);

    expect(result.object).toBe('list');
    expect(scope.isDone()).toBe(true);
  });

  it('passes on the API message for a revoked or unknown key', async () => {
    nock(API)
      .get('/api/v1/contacts')
      .query(true)
      .reply(401, { error: 'This API key is not valid or was revoked' });

    const bundle = { authData: { api_key: GOOD_KEY } };
    await expect(appTester(App.authentication.test, bundle)).rejects.toThrow(/not valid or was revoked/);
  });

  it('refuses something that is not a get-ly key without calling the API', async () => {
    const bundle = { authData: { api_key: 'sk_live_not_ours' } };
    await expect(appTester(App.authentication.test, bundle)).rejects.toThrow(/starts with gk_/);
  });
});
