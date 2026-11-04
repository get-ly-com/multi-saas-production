'use strict';

const { create, compact } = require('../lib/api');

// NOT LIVE YET. API keys can only add contacts and leads: POST /api/v1/invoices answers 405 today.
// This action is written to the body the app's own invoice form sends to the accounting service
// (customer_id, invoice_date, due_date, description, line_items[{ description, quantity,
// unit_price }]), and stays hidden in Zapier until the gateway accepts invoice writes from
// "read and write" keys (API_WRITABLE in the gateway, integrations.api_create in the database).
// Then remove `hidden: true` below and push a new version.

const perform = (z, bundle) => {
  const input = bundle.inputData;
  const quantity = Number(input.quantity || 1);
  const unitPrice = Number(input.unit_price);
  if (!(quantity > 0)) throw new z.errors.Error('Quantity must be more than 0', 'invalid_input', 422);
  if (!(unitPrice >= 0)) throw new z.errors.Error('Enter a price of 0 or more', 'invalid_input', 422);

  return create(z, 'invoices', compact({
    status: 'draft',
    customer_id: input.customer_id,
    invoice_date: input.invoice_date,
    due_date: input.due_date,
    description: input.description,
    currency: input.currency,
    line_items: [{ description: input.line_description, quantity, unit_price: unitPrice }]
  }));
};

module.exports = {
  key: 'create_invoice',
  noun: 'Invoice',
  display: {
    label: 'Create Draft Invoice',
    description: 'Makes a draft invoice with one line, ready for you to check and send in get-ly.',
    hidden: true
  },
  operation: {
    inputFields: [
      { key: 'customer_id', label: 'Customer ID', required: true, helpText: 'The get-ly customer this invoice is for.' },
      { key: 'line_description', label: 'What it is for', required: true },
      { key: 'quantity', label: 'Quantity', type: 'number', default: '1' },
      { key: 'unit_price', label: 'Price each', type: 'number', required: true },
      { key: 'invoice_date', label: 'Invoice date', type: 'datetime', helpText: 'Left blank, it is today.' },
      { key: 'due_date', label: 'Due date', type: 'datetime' },
      { key: 'currency', label: 'Currency', helpText: 'Three letters, like USD. Left blank, it is your base currency.' },
      { key: 'description', label: 'Note on the invoice', type: 'text' }
    ],
    perform,
    sample: {
      id: '5d2a9f10-8c4e-4b7d-9e21-3a6f0c8b2d44',
      invoice_number: 'INV-0043',
      status: 'draft',
      customer_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
      customer_name: 'Acme Trading',
      amount: 250,
      currency: 'USD',
      created_at: '2026-11-04T11:00:00.000Z',
      was_new: true
    },
    outputFields: [
      { key: 'id', label: 'Invoice ID' },
      { key: 'invoice_number', label: 'Invoice number' },
      { key: 'status', label: 'Status' },
      { key: 'amount', label: 'Total', type: 'number' }
    ]
  }
};
