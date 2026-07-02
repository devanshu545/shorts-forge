
ALTER TABLE public.autopilot_settings
  ADD COLUMN IF NOT EXISTS slot_times text[] NOT NULL DEFAULT ARRAY['09:00','13:00','19:00']::text[],
  ADD COLUMN IF NOT EXISTS pause_days int[] NOT NULL DEFAULT ARRAY[]::int[],
  ADD COLUMN IF NOT EXISTS failure_streak int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS characters_pool text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS voices_pool text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS style_preset text NOT NULL DEFAULT 'pixar',
  ADD COLUMN IF NOT EXISTS hashtag_pool text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS auto_pause_on_failures boolean NOT NULL DEFAULT true;

-- Backfill slot_times from existing slot_hours where empty
UPDATE public.autopilot_settings
SET slot_times = (
  SELECT ARRAY(SELECT LPAD(h::text, 2, '0') || ':00' FROM unnest(slot_hours) AS h ORDER BY h)
)
WHERE (slot_times IS NULL OR array_length(slot_times, 1) IS NULL) AND slot_hours IS NOT NULL;
