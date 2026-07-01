ALTER TABLE public.youtube_connections
  ADD COLUMN IF NOT EXISTS channel_description text,
  ADD COLUMN IF NOT EXISTS channel_banner text,
  ADD COLUMN IF NOT EXISTS channel_created_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS made_for_kids boolean,
  ADD COLUMN IF NOT EXISTS statistics jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS analytics jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS metadata_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS generation_job_id text,
  ADD COLUMN IF NOT EXISTS generation_progress integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS generation_stage text,
  ADD COLUMN IF NOT EXISTS uploaded_at timestamp with time zone;

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own notifications" ON public.notifications;
CREATE POLICY "own notifications" ON public.notifications FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS videos_generation_job_idx ON public.videos(generation_job_id);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON public.notifications(user_id, created_at DESC);