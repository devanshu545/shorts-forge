REVOKE ALL ON FUNCTION public.claim_next_long_video_job(text, uuid, interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_next_long_video_job(text, uuid, interval, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_next_long_video_job(text, uuid, interval, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_long_video_job(text, uuid, interval, integer) TO service_role;

REVOKE ALL ON FUNCTION public.log_long_video_event(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_long_video_event(uuid, uuid, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.log_long_video_event(uuid, uuid, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.log_long_video_event(uuid, uuid, text, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.mark_stale_long_video_jobs(interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_stale_long_video_jobs(interval, integer) FROM anon;
REVOKE ALL ON FUNCTION public.mark_stale_long_video_jobs(interval, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_stale_long_video_jobs(interval, integer) TO service_role;