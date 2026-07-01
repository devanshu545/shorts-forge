
-- updated_at helper
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- video status enum
CREATE TYPE public.video_status AS ENUM (
  'draft','queued','scripting','generating_video','generating_audio','uploading','ready','failed','scheduled','published'
);

-- videos
CREATE TABLE public.videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled',
  script JSONB,
  video_url TEXT,
  thumbnail_url TEXT,
  audio_url TEXT,
  duration_seconds INTEGER,
  file_size_bytes BIGINT,
  status public.video_status NOT NULL DEFAULT 'draft',
  seo_keywords TEXT[] DEFAULT '{}',
  hashtags TEXT[] DEFAULT '{}',
  description TEXT,
  error_message TEXT,
  scheduled_for TIMESTAMPTZ,
  youtube_video_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX videos_user_created_idx ON public.videos(user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.videos TO authenticated;
GRANT ALL ON public.videos TO service_role;
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own videos" ON public.videos FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER videos_updated_at BEFORE UPDATE ON public.videos FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- scheduled jobs
CREATE TYPE public.cadence AS ENUM ('once','daily','weekly');
CREATE TABLE public.scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  niche TEXT NOT NULL,
  tone TEXT,
  hook_style TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 30,
  cadence public.cadence NOT NULL DEFAULT 'daily',
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  auto_upload BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_jobs_due_idx ON public.scheduled_jobs(active, next_run_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduled_jobs TO authenticated;
GRANT ALL ON public.scheduled_jobs TO service_role;
ALTER TABLE public.scheduled_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own jobs" ON public.scheduled_jobs FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER scheduled_jobs_updated_at BEFORE UPDATE ON public.scheduled_jobs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- youtube connections (tokens stored server-side; RLS blocks direct client read)
CREATE TABLE public.youtube_connections (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id TEXT,
  channel_title TEXT,
  channel_thumbnail TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.youtube_connections TO authenticated;
GRANT ALL ON public.youtube_connections TO service_role;
ALTER TABLE public.youtube_connections ENABLE ROW LEVEL SECURITY;
-- Client can check connection exists but NOT read tokens directly (we filter via a view)
CREATE POLICY "own connection" ON public.youtube_connections FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER youtube_connections_updated_at BEFORE UPDATE ON public.youtube_connections FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Safe view exposing only non-secret channel info
CREATE VIEW public.youtube_channel_info WITH (security_invoker=on) AS
  SELECT user_id, channel_id, channel_title, channel_thumbnail, scope, connected_at
  FROM public.youtube_connections;
GRANT SELECT ON public.youtube_channel_info TO authenticated;

-- analytics snapshots
CREATE TABLE public.analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  video_id UUID REFERENCES public.videos(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'youtube',
  metrics JSONB NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analytics_user_time_idx ON public.analytics_snapshots(user_id, snapshot_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_snapshots TO authenticated;
GRANT ALL ON public.analytics_snapshots TO service_role;
ALTER TABLE public.analytics_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own analytics" ON public.analytics_snapshots FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Realtime for videos so client can watch status updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.videos;
