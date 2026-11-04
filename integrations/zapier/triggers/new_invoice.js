'use strict';

const { newest } = require('../lib/api');

const sample = {
  id: '5d2a9f10-8c4e-4b7d-9e21-3a6f0c8b2d44',
  invoice_number: 'INV-0042',
  status: 'sent',
  customer_id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  customer_name: 'Acme Trading',
  invoice_date: '2026-11-01',
  due_date: '2026-12-01',
  currency: 'USD',
  subtotal: 1000,
  tax_amount: 200,
  amount: 1200,
  amount_paid: 0,
  amount_credited: 0,
  paid_at: null,
  created_at: '2026-11-01T10:00:00.000Z',
  updated_at: '2026-11-01T10:00:00.000Z'
};

const outputFields = [
  { key: 'id', label: 'Invoice ID' },
  { key: 'invoice_number', label: 'Invoice number' },
  { key: 'status', label: 'Status' },
  { key: 'customer_id', label: 'Customer ID' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'invoice_date', label: 'Invoice date', type: 'datetime' },
  { key: 'due_date', label: 'Due date', type: 'datetime' },
  { key: 'currency', label: 'Currency' },
  { key: 'subtotal', label: 'Subtotal', type: 'number' },
  { key: 'tax_amount', label: 'Tax', type: 'number' },
  { key: 'amount', label: 'Total', type: 'number' },
  { key: 'amount_paid', label: 'Paid so far', type: 'number' },
  { key: 'amount_credited', label: 'Credited', type: 'number' },
  { key: 'paid_at', label: 'Paid at', type: 'datetime' },
  { key: 'created_at', label: 'Created at', type: 'datetime' }
];

module.exports = {
  key: 'new_invoice',
  noun: 'Invoice',
  display: {
    label: 'New Invoice',
    description: 'Triggers when an invoice is created, drafts included.'
  },
  operation: {
    perform: (z) => newest(z, 'invoices'),
    sample,
    outputFields
  }
};
