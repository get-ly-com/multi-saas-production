'use strict';

const { newest } = require('../lib/api');
const newInvoice = require('./new_invoice');

// The API has no "paid since" filter or sort, so this reads the most recent invoices (by when
// they were made) and keeps the paid ones, latest payment first. An invoice made long ago and
// paid today is only noticed while it is among the last LOOK_BACK invoices. See the README.
const LOOK_BACK = 300;

const perform = async (z) => {
  const recent = await newest(z, 'invoices', LOOK_BACK);
  return recent
    .filter((invoice) => invoice.status === 'paid')
    .sort((a, b) => String(b.paid_at || b.updated_at || '').localeCompare(String(a.paid_at || a.updated_at || '')))
    // Zapier fires once per id, so one paid event per invoice
    .map((invoice) => ({ ...invoice, id: `${invoice.id}-paid`, invoice_id: invoice.id }));
};

const { sample, outputFields } = newInvoice.operation;

module.exports = {
  key: 'invoice_paid',
  noun: 'Invoice',
  display: {
    label: 'Invoice Paid',
    description: 'Triggers when an invoice is paid in full.'
  },
  operation: {
    perform,
    sample: {
      ...sample,
      id: `${sample.id}-paid`,
      invoice_id: sample.id,
      status: 'paid',
      amount_paid: 1200,
      paid_at: '2026-11-03T16:20:00.000Z'
    },
    outputFields: [{ key: 'invoice_id', label: 'Invoice ID' }, ...outputFields.filter(({ key }) => key !== 'id')]
  }
};
