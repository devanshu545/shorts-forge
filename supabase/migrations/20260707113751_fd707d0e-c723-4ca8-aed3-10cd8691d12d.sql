-- Explicit deny policies for long_video_events writes (defense in depth; writes go through SECURITY DEFINER RPC)
CREATE POLICY "Deny direct inserts on long_video_events"
  ON public.long_video_events FOR INSERT TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY "Deny direct updates on long_video_events"
  ON public.long_video_events FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY "Deny direct deletes on long_video_events"
  ON public.long_video_events FOR DELETE TO authenticated, anon
  USING (false);