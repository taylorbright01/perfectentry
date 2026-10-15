-- Deploy the account Worker and verify paid-member access BEFORE running this.
-- Historical performance stays public; active/recent signals require the server.
BEGIN;
CREATE OR REPLACE VIEW public.public_signal_history WITH (security_barrier=true) AS
SELECT * FROM public.public_signal_feed
WHERE coalesce(display_closed_at,closed_at,shadow_closed_at) < now() - interval '15 minutes';
GRANT SELECT ON public.public_signal_history TO anon,authenticated,service_role;
COMMIT;
-- Safe first migration: create the historical source before uploading the new
-- public performance pages. Apply 0002 only after paid signals have been tested.
