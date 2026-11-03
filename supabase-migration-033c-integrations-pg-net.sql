-- pg_net was registered in the public schema; Supabase's advice is to keep extensions in
-- "extensions". Its functions and tables live in the "net" schema either way, so this only moves
-- the extension's registration. Nothing was queued and only integrations.dispatch uses it.
DROP EXTENSION IF EXISTS pg_net;
CREATE EXTENSION pg_net WITH SCHEMA extensions;
