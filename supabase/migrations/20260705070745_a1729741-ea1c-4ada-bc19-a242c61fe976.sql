DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'autopilot_heartbeats'
      AND policyname = 'No client access to worker heartbeats'
  ) THEN
    CREATE POLICY "No client access to worker heartbeats"
      ON public.autopilot_heartbeats
      FOR ALL
      TO authenticated
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;