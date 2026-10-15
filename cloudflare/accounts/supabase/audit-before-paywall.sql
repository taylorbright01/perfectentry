-- Read-only inventory: check raw-signal consumers and grants before migration.
SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name IN ('signals','public_signal_feed','public_signal_history');
SELECT schemaname,tablename,policyname,roles,cmd,qual FROM pg_policies WHERE tablename='signals';
SELECT schemaname,viewname,definition FROM pg_views WHERE schemaname='public' AND definition ILIKE '%signals%';
SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' AND routine_definition ILIKE '%signals%';
