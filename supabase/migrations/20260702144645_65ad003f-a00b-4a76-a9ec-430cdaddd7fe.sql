-- 1. Instagram connections table
CREATE TABLE public.instagram_connections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  ig_business_account_id TEXT NOT NULL,
  fb_page_id TEXT,
  page_access_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  username TEXT,
  followers_count INTEGER DEFAULT 0,
  media_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_connections TO authenticated;
GRANT ALL ON public.instagram_connections TO service_role;

ALTER TABLE public.instagram_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own instagram connection"
  ON public.instagram_connections
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER set_instagram_connections_updated_at
  BEFORE UPDATE ON public.instagram_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Instagram fields on videos
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS instagram_media_id TEXT,
  ADD COLUMN IF NOT EXISTS instagram_permalink TEXT,
  ADD COLUMN IF NOT EXISTS instagram_error TEXT,
  ADD COLUMN IF NOT EXISTS ig_caption TEXT,
  ADD COLUMN IF NOT EXISTS ig_hashtags TEXT[] DEFAULT ARRAY[]::TEXT[];

-- 3. Minute-precision slot support on autopilot_settings
ALTER TABLE public.autopilot_settings
  ADD COLUMN IF NOT EXISTS slot_minutes INTEGER[] DEFAULT ARRAY[]::INTEGER[];
