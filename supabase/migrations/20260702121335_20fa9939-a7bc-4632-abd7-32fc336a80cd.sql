DROP POLICY IF EXISTS "Authenticated can read heartbeats" ON public.autopilot_heartbeats;
REVOKE SELECT ON public.autopilot_heartbeats FROM authenticated;
