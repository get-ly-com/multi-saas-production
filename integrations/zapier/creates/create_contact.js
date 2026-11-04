'use strict';

const { create, compact } = require('../lib/api');

// POST /api/v1/contacts. Needs a "read and write" key. When a contact already has this email,
// the API returns that contact instead of adding a second one (was_new is then false).
module.exports = {
  key: 'create_contact',
  noun: 'Contact',
  display: {
    label: 'Create Contact',
    description: 'Adds a contact to the CRM, or finds the one that already has this email.'
  },
  operation: {
    inputFields: [
      { key: 'name', label: 'Full name', helpText: 'Or fill in first and last name instead.' },
      { key: 'first_name', label: 'First name' },
      { key: 'last_name', label: 'Last name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'job_title', label: 'Job title' },
      { key: 'notes', label: 'Notes', type: 'text', helpText: 'Up to 2,000 characters.' },
      { key: 'source', label: 'Source', helpText: 'Where this contact came from. Left blank, it is "API".' },
      { key: 'campaign', label: 'Campaign' }
    ],
    perform: (z, bundle) => create(z, 'contacts', compact(bundle.inputData)),
    sample: {
      id: '7c1f6a2e-3b1d-4f0a-9a51-2f0d6c1b9e11',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+44 20 7946 0000',
      job_title: 'Analyst',
      company_id: null,
      source: 'API',
      created_at: '2026-11-01T09:30:00.000Z',
      updated_at: '2026-11-01T09:30:00.000Z',
      was_new: true
    },
    outputFields: [
      { key: 'id', label: 'Contact ID' },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'was_new', label: 'Was a new contact', type: 'boolean' }
    ]
  }
};
