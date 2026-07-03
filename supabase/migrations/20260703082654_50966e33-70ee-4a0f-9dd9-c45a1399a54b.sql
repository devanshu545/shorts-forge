
CREATE TABLE public.long_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_path text NOT NULL,
  original_filename text,
  size_bytes bigint,
  duration_seconds int,
  clip_length int NOT NULL DEFAULT 55,
  max_clips int NOT NULL DEFAULT 5,
  status text NOT NULL DEFAULT 'queued',
  error_message text,
  clips_generated int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.long_videos TO authenticated;
GRANT ALL ON public.long_videos TO service_role;
ALTER TABLE public.long_videos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own long_videos" ON public.long_videos FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER long_videos_set_updated_at BEFORE UPDATE ON public.long_videos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS long_video_id uuid REFERENCES public.long_videos(id) ON DELETE SET NULL;
ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS clip_start_seconds real;
ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS clip_end_seconds real;
CREATE INDEX IF NOT EXISTS videos_long_video_id_idx ON public.videos(long_video_id);
