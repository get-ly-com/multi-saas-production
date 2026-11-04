'use strict';

const { baseUrl } = require('./lib/api');

// get-ly API keys look like gk_ followed by 48 hex characters. Owners and admins make them in
// get-ly under Integrations > API keys. A "read" key is enough for triggers; adding contacts and
// leads needs a key made to "read and write".
module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'api_key',
      label: 'API key',
      type: 'password',
      required: true,
      helpText: 'In get-ly, go to **Integrations > API keys** and make a key. Choose **read and write** if your Zaps will add contacts or leads. The key starts with `gk_` and is shown only once.'
    }
  ],
  // Any cheap read proves the key works and is not revoked
  test: async (z, bundle) => {
    const key = (bundle.authData.api_key || '').trim();
    if (!/^gk_[0-9a-f]{48}$/.test(key)) {
      throw new z.errors.Error('That doesn’t look like a get-ly API key. It starts with gk_ and has 48 more letters and numbers.', 'invalid_key', 401);
    }
    const response = await z.request({ url: `${baseUrl()}/contacts`, params: { limit: 1, offset: 0 } });
    return response.data;
  },
  connectionLabel: 'get-ly API key'
};
