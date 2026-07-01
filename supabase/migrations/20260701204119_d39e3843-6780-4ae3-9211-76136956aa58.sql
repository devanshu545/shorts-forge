DROP POLICY IF EXISTS "own thumbnails read" ON storage.objects;
DROP POLICY IF EXISTS "own thumbnails write" ON storage.objects;
DROP POLICY IF EXISTS "own thumbnails update" ON storage.objects;
DROP POLICY IF EXISTS "own thumbnails delete" ON storage.objects;

CREATE POLICY "own thumbnails read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'thumbnails' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own thumbnails write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'thumbnails' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own thumbnails update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'thumbnails' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'thumbnails' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own thumbnails delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'thumbnails' AND (storage.foldername(name))[1] = auth.uid()::text);