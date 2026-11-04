'use strict';

const { newest } = require('../lib/api');

module.exports = {
  key: 'new_contact',
  noun: 'Contact',
  display: {
    label: 'New Contact',
    description: 'Triggers when a contact is added to the CRM.'
  },
  operation: {
    perform: (z) => newest(z, 'contacts'),
    sample: {
      id: '7c1f6a2e-3b1d-4f0a-9a51-2f0d6c1b9e11',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+44 20 7946 0000',
      job_title: 'Analyst',
      company_id: null,
      source: 'Website',
      created_at: '2026-11-01T09:30:00.000Z',
      updated_at: '2026-11-01T09:30:00.000Z'
    },
    outputFields: [
      { key: 'id', label: 'Contact ID' },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'job_title', label: 'Job title' },
      { key: 'company_id', label: 'Company ID' },
      { key: 'source', label: 'Source' },
      { key: 'created_at', label: 'Added at', type: 'datetime' }
    ]
  }
};
