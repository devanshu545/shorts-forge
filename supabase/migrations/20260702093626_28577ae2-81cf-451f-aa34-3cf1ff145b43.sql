
CREATE TABLE IF NOT EXISTS public.autopilot_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  videos_per_day INT NOT NULL DEFAULT 3 CHECK (videos_per_day BETWEEN 1 AND 5),
  slot_hours INT[] NOT NULL DEFAULT ARRAY[9,13,19],
  topic_mode TEXT NOT NULL DEFAULT 'trending' CHECK (topic_mode IN ('trending','niche','mix')),
  niche TEXT,
  tone TEXT NOT NULL DEFAULT 'wholesome and funny',
  character_key TEXT NOT NULL DEFAULT 'ginger_cat',
  voice TEXT NOT NULL DEFAULT 'alloy',
  privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public','unlisted','private')),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.autopilot_settings TO authenticated;
GRANT ALL ON public.autopilot_settings TO service_role;
ALTER TABLE public.autopilot_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own autopilot" ON public.autopilot_settings FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS autopilot_slot TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_videos_autopilot_slot ON public.videos(user_id, autopilot_slot);
