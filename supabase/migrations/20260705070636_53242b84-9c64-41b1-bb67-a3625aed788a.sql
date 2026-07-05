ALTER TABLE public.long_videos
  ADD COLUMN IF NOT EXISTS upload_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS upload_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS worker_run_id text,
  ADD COLUMN IF NOT EXISTS progress_percent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_stage text,
  ADD COLUMN IF NOT EXISTS failure_code text;

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS clip_index integer,
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_run_id text;

CREATE TABLE IF NOT EXISTS public.long_video_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  long_video_id uuid NOT NULL REFERENCES public.long_videos(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.long_video_events TO authenticated;
GRANT ALL ON public.long_video_events TO service_role;

ALTER TABLE public.long_video_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'long_video_events'
      AND policyname = 'Users can view their own long video events'
  ) THEN
    CREATE POLICY "Users can view their own long video events"
      ON public.long_video_events
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS long_videos_user_created_idx
  ON public.long_videos(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS long_videos_worker_queue_idx
  ON public.long_videos(status, updated_at, created_at)
  WHERE status IN ('uploaded', 'queued', 'processing', 'failed_retryable');

CREATE INDEX IF NOT EXISTS long_videos_user_status_idx
  ON public.long_videos(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS videos_long_video_clip_idx
  ON public.videos(long_video_id, clip_index, clip_start_seconds)
  WHERE long_video_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS videos_long_video_clip_unique_idx
  ON public.videos(long_video_id, clip_index)
  WHERE long_video_id IS NOT NULL AND clip_index IS NOT NULL;

DROP TRIGGER IF EXISTS set_long_videos_updated_at ON public.long_videos;
CREATE TRIGGER set_long_videos_updated_at
  BEFORE UPDATE ON public.long_videos
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_videos_updated_at ON public.videos;
CREATE TRIGGER set_videos_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.claim_next_long_video_job(
  _worker_id text,
  _explicit_id uuid DEFAULT NULL,
  _stale_after interval DEFAULT interval '15 minutes',
  _max_attempts integer DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  source_path text,
  clip_length integer,
  max_clips integer,
  status text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT lv.id
    FROM public.long_videos lv
    WHERE
      (
        _explicit_id IS NOT NULL
        AND lv.id = _explicit_id
        AND lv.status IN ('uploaded', 'queued', 'processing', 'failed_retryable')
      )
      OR
      (
        _explicit_id IS NULL
        AND (
          lv.status IN ('uploaded', 'queued', 'failed_retryable')
          OR (lv.status = 'processing' AND COALESCE(lv.last_progress_at, lv.updated_at, lv.processing_started_at, lv.created_at) < now() - _stale_after)
        )
      )
    ORDER BY
      CASE WHEN lv.status = 'processing' THEN 0 ELSE 1 END,
      lv.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.long_videos lv
    SET
      status = 'processing',
      processing_started_at = COALESCE(lv.processing_started_at, now()),
      last_progress_at = now(),
      locked_at = now(),
      locked_by = _worker_id,
      worker_run_id = _worker_id,
      attempt_count = lv.attempt_count + 1,
      progress_percent = GREATEST(lv.progress_percent, 5),
      progress_stage = 'Worker claimed job',
      error_message = NULL,
      failure_code = NULL
    FROM candidate
    WHERE lv.id = candidate.id
      AND lv.attempt_count < _max_attempts
    RETURNING lv.id, lv.user_id, lv.source_path, lv.clip_length, lv.max_clips, lv.status, lv.attempt_count
  )
  SELECT claimed.id, claimed.user_id, claimed.source_path, claimed.clip_length, claimed.max_clips, claimed.status, claimed.attempt_count
  FROM claimed;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_next_long_video_job(text, uuid, interval, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.log_long_video_event(
  _long_video_id uuid,
  _user_id uuid,
  _event_type text,
  _message text,
  _detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.long_video_events(long_video_id, user_id, event_type, message, detail)
  VALUES (_long_video_id, _user_id, _event_type, LEFT(_message, 1000), COALESCE(_detail, '{}'::jsonb));
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_long_video_event(uuid, uuid, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_stale_long_video_jobs(
  _stale_after interval DEFAULT interval '25 minutes',
  _max_attempts integer DEFAULT 3
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count integer;
BEGIN
  UPDATE public.long_videos
  SET
    status = CASE WHEN attempt_count >= _max_attempts THEN 'failed_final' ELSE 'failed_retryable' END,
    failure_code = 'stale_worker',
    error_message = CASE WHEN attempt_count >= _max_attempts
      THEN 'Processing stopped without progress after multiple attempts.'
      ELSE 'Processing stopped without progress. The job is ready to retry.'
    END,
    progress_stage = 'Worker heartbeat timed out',
    locked_at = NULL,
    locked_by = NULL
  WHERE status = 'processing'
    AND COALESCE(last_progress_at, updated_at, processing_started_at, created_at) < now() - _stale_after;

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_stale_long_video_jobs(interval, integer) TO service_role;