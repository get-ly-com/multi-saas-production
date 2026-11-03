-- Which campaign brought a lead or contact in, so social posts can be linked to the people they bring
ALTER TABLE crm.leads ADD COLUMN IF NOT EXISTS campaign TEXT CHECK (length(campaign) <= 100);
ALTER TABLE crm.contacts ADD COLUMN IF NOT EXISTS campaign TEXT CHECK (length(campaign) <= 100);
CREATE INDEX IF NOT EXISTS idx_crm_leads_campaign ON crm.leads (tenant_id, lower(campaign)) WHERE campaign IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_campaign ON crm.contacts (tenant_id, lower(campaign)) WHERE campaign IS NOT NULL;
