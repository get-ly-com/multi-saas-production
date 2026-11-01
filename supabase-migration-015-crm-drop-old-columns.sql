-- The new CRM service is live, so the old free-text columns can go.
ALTER TABLE crm.contacts DROP COLUMN company;
ALTER TABLE crm.deals DROP COLUMN stage;

NOTIFY pgrst, 'reload schema';
