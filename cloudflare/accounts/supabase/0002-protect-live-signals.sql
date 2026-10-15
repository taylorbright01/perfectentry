-- Review anonymous SELECT dependencies first. Does not change INSERT/UPDATE grants.
-- Run only after the paid signal proxy, member checks and public history pages work.
BEGIN;
REVOKE SELECT ON public.public_signal_feed,public.signals FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.public_signal_feed,public.signals TO service_role;
COMMIT;
-- A user without a membership must get 401/403 from /signals, and anon direct
-- selects of BOTH relations must fail. Other views/RPCs exposing live rows must
-- also be closed; audit the production schema before declaring the paywall live.
