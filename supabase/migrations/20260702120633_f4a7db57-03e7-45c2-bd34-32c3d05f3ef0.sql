CREATE TABLE IF NOT EXISTS public.autopilot_heartbeats (
  source text PRIMARY KEY,
  last_ping timestamptz NOT NULL DEFAULT now(),
  detail jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.autopilot_heartbeats TO authenticated;
GRANT ALL ON public.autopilot_heartbeats TO service_role;

ALTER TABLE public.autopilot_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read heartbeats"
  ON public.autopilot_heartbeats
  FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS videos_user_slot_idx
  ON public.videos (user_id, autopilot_slot);
