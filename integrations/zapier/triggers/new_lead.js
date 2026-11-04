'use strict';

const { newest } = require('../lib/api');

module.exports = {
  key: 'new_lead',
  noun: 'Lead',
  display: {
    label: 'New Lead',
    description: 'Triggers when a lead comes in: from a web form, an incoming webhook, the API or added by hand.'
  },
  operation: {
    perform: (z) => newest(z, 'leads'),
    sample: {
      id: '0b8e2c55-6f2d-4a3c-8a3e-5b9c1f4d7a20',
      name: 'Grace Hopper',
      email: 'grace@example.com',
      phone: null,
      company_name: 'Compilers Ltd',
      job_title: 'Director',
      source: 'Web form',
      campaign: 'autumn-offer',
      status: 'new',
      score: 40,
      converted_contact_id: null,
      converted_at: null,
      created_at: '2026-11-02T14:05:00.000Z',
      updated_at: '2026-11-02T14:05:00.000Z'
    },
    outputFields: [
      { key: 'id', label: 'Lead ID' },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'company_name', label: 'Company' },
      { key: 'job_title', label: 'Job title' },
      { key: 'source', label: 'Source' },
      { key: 'campaign', label: 'Campaign' },
      { key: 'status', label: 'Status' },
      { key: 'score', label: 'Score', type: 'integer' },
      { key: 'created_at', label: 'Received at', type: 'datetime' }
    ]
  }
};
