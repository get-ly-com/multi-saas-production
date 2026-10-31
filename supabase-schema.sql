-- Multi-Tenant SaaS Schema
-- Public Schema: Tenants and Users
CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  app_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT now()
);

-- ACCOUNTING SCHEMA
CREATE SCHEMA IF NOT EXISTS accounting;

CREATE TABLE IF NOT EXISTS accounting.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  invoice_number TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status TEXT DEFAULT 'draft',
  description TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(tenant_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS accounting.expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  category TEXT,
  description TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- CRM SCHEMA
CREATE SCHEMA IF NOT EXISTS crm;

CREATE TABLE IF NOT EXISTS crm.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  contact_id UUID REFERENCES crm.contacts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  value DECIMAL(10,2),
  stage TEXT DEFAULT 'prospecting',
  created_at TIMESTAMP DEFAULT now()
);

-- INVENTORY SCHEMA
CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE IF NOT EXISTS inventory.items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INT DEFAULT 0,
  price DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(tenant_id, sku)
);

-- Enable Row Level Security
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.items ENABLE ROW LEVEL SECURITY;

-- RLS Policies (simplified)
CREATE POLICY "tenants_access" ON public.tenants FOR SELECT USING (true);
CREATE POLICY "invoices_access" ON accounting.invoices FOR ALL USING (true);
CREATE POLICY "contacts_access" ON crm.contacts FOR ALL USING (true);
CREATE POLICY "deals_access" ON crm.deals FOR ALL USING (true);
CREATE POLICY "items_access" ON inventory.items FOR ALL USING (true);

-- Create Tenants (one per app)
INSERT INTO public.tenants (name, app_name) VALUES
  ('Accounting App', 'accounting'),
  ('CRM App', 'crm'),
  ('Inventory Manager', 'inventory'),
  ('Customer Support', 'chatbot'),
  ('Video Conferencing', 'video'),
  ('Appointment Scheduler', 'scheduler'),
  ('HR System', 'hr'),
  ('Social Media Manager', 'social-media')
ON CONFLICT DO NOTHING;

-- Create Indexes for Performance
CREATE INDEX idx_invoices_tenant ON accounting.invoices(tenant_id);
CREATE INDEX idx_expenses_tenant ON accounting.expenses(tenant_id);
CREATE INDEX idx_contacts_tenant ON crm.contacts(tenant_id);
CREATE INDEX idx_deals_tenant ON crm.deals(tenant_id);
CREATE INDEX idx_items_tenant ON inventory.items(tenant_id);
