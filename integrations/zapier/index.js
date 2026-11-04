'use strict';

const { version } = require('./package.json');
const { version: platformVersion } = require('zapier-platform-core');

const authentication = require('./authentication');
const { addApiKey, handleErrors } = require('./lib/api');

const newInvoice = require('./triggers/new_invoice');
const invoicePaid = require('./triggers/invoice_paid');
const newContact = require('./triggers/new_contact');
const newLead = require('./triggers/new_lead');
const newBooking = require('./triggers/new_booking');

const createContact = require('./creates/create_contact');
const createLead = require('./creates/create_lead');
const createInvoice = require('./creates/create_invoice');

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [handleErrors],
  triggers: {
    [newInvoice.key]: newInvoice,
    [invoicePaid.key]: invoicePaid,
    [newContact.key]: newContact,
    [newLead.key]: newLead,
    [newBooking.key]: newBooking
  },
  creates: {
    [createContact.key]: createContact,
    [createLead.key]: createLead,
    [createInvoice.key]: createInvoice
  }
};
