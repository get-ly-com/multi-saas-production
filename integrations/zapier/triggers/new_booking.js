'use strict';

const { newest } = require('../lib/api');

// NOT LIVE YET. The public API does not list bookings: the gateway only serves contacts,
// invoices, items, deals and leads to API keys. This trigger is written against the same list
// shape (GET /api/v1/bookings, oldest first by created_at) and stays hidden in Zapier until
// "bookings" is added to API_RESOURCES in the gateway and to integrations.api_rows in the database.
// Then remove `hidden: true` below and push a new version.

module.exports = {
  key: 'new_booking',
  noun: 'Booking',
  display: {
    label: 'New Booking',
    description: 'Triggers when someone books a time with you.',
    hidden: true
  },
  operation: {
    perform: (z) => newest(z, 'bookings'),
    sample: {
      id: '3e7d1c90-2a4b-4f6e-8d10-9b2c5a7e1f33',
      booking_type: 'Intro call',
      starts_at: '2026-11-10T15:00:00.000Z',
      ends_at: '2026-11-10T15:30:00.000Z',
      status: 'confirmed',
      name: 'Alan Turing',
      email: 'alan@example.com',
      created_at: '2026-11-04T08:12:00.000Z'
    },
    outputFields: [
      { key: 'id', label: 'Booking ID' },
      { key: 'booking_type', label: 'Booking type' },
      { key: 'starts_at', label: 'Starts at', type: 'datetime' },
      { key: 'ends_at', label: 'Ends at', type: 'datetime' },
      { key: 'status', label: 'Status' },
      { key: 'name', label: 'Booked by' },
      { key: 'email', label: 'Email' },
      { key: 'created_at', label: 'Booked at', type: 'datetime' }
    ]
  }
};
