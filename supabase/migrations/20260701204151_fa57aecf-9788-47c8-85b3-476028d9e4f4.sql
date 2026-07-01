ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS video_storage_path text,
  ADD COLUMN IF NOT EXISTS thumbnail_storage_path text;

CREATE INDEX IF NOT EXISTS videos_video_storage_path_idx ON public.videos(video_storage_path);