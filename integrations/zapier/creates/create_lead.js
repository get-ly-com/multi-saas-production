'use strict';

const { create, compact } = require('../lib/api');

// POST /api/v1/leads. Needs a "read and write" key and an email or a phone number. When an open
// lead already has this email, the API adds a note to it instead of a duplicate (was_new false).
module.exports = {
  key: 'create_lead',
  noun: 'Lead',
  display: {
    label: 'Create Lead',
    description: 'Adds a lead, or notes the new enquiry on the open lead that already has this email.'
  },
  operation: {
    inputFields: [
      { key: 'name', label: 'Full name', helpText: 'Or fill in first and last name instead.' },
      { key: 'first_name', label: 'First name' },
      { key: 'last_name', label: 'Last name' },
      { key: 'email', label: 'Email', helpText: 'An email or a phone number is needed.' },
      { key: 'phone', label: 'Phone' },
      { key: 'company', label: 'Company' },
      { key: 'job_title', label: 'Job title' },
      { key: 'message', label: 'Message', type: 'text', helpText: 'What they asked about. Up to 2,000 characters.' },
      { key: 'source', label: 'Source', helpText: 'Where this lead came from. Left blank, it is "API".' },
      { key: 'campaign', label: 'Campaign' }
    ],
    perform: (z, bundle) => create(z, 'leads', compact(bundle.inputData)),
    sample: {
      id: '0b8e2c55-6f2d-4a3c-8a3e-5b9c1f4d7a20',
      name: 'Grace Hopper',
      email: 'grace@example.com',
      phone: null,
      company_name: 'Compilers Ltd',
      job_title: 'Director',
      source: 'API',
      campaign: null,
      status: 'new',
      score: 0,
      converted_contact_id: null,
      converted_at: null,
      created_at: '2026-11-02T14:05:00.000Z',
      updated_at: '2026-11-02T14:05:00.000Z',
      was_new: true
    },
    outputFields: [
      { key: 'id', label: 'Lead ID' },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'status', label: 'Status' },
      { key: 'was_new', label: 'Was a new lead', type: 'boolean' }
    ]
  }
};
