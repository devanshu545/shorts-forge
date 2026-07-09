## Goal
Prove exactly whether the existing post-generation Shorts conversion layer runs, creates a portrait upload-ready file, previews that file, and sends that file to YouTube — without changing the working Long Video → Shorts generation pipeline.

## Non-negotiable boundaries
I will not modify:
- Upload/generation pipeline
- AI clip detection
- Scene detection
- Rendering
- FFmpeg generation for clip creation
- Native worker
- Queue
- Database schema/storage structure
- Library/download behavior
- Existing auth/API behavior outside the upload-prep path

Only the isolated post-generation upload-preparation path will be touched.

## Plan
1. Add temporary, explicit debug logging to the existing client upload-prep function.
   - Log `Original generated MP4 details logged.`
   - Log original source URL, width, height, duration, codec, file size, rotation, and validation reasons.
   - Log `Validation started.`
   - Log `Conversion started.` only when ffmpeg.wasm actually runs.
   - Log `Conversion completed.` when the converted Blob is produced.
   - Log converted width, height, duration, codec, file size, rotation, and validation result.
   - Log `Upload-ready MP4 created.` and `Upload-ready MP4 validated.`

2. Fix the main upload dialog preview to show the exact upload-ready copy when it exists.
   - Keep the original generated MP4 untouched.
   - Before upload, create a local object URL for the prepared Blob.
   - Switch the dialog preview/download link to that prepared object URL once available.
   - Clearly expose/download the upload-ready copy for manual verification.
   - Keep library thumbnails/detail previews unchanged except inside this upload dialog.

3. Add a strict client-side upload handoff check.
   - If conversion was needed, require `preparedStoragePath` before calling the upload server function.
   - Abort if the upload would fall back to the original landscape MP4 after conversion was required.
   - Log `USING FILE FOR UPLOAD: <source>` and `Converted = true/false` before upload is requested.

4. Add strict server-side upload-source diagnostics and guardrails.
   - Log whether the server downloads from `preparedStoragePath`, original storage path, or original URL.
   - Log `USING FILE FOR UPLOAD: <source>` and `Converted = true/false` immediately before upload.
   - Validate selected bytes before YouTube upload.
   - Abort if selected bytes are not portrait 9:16 or if a prepared copy was expected but missing.

5. Apply the same investigation logging and guardrails to bulk publish, but only in the upload-prep section.
   - Add per-clip logs so one failing item shows exactly which stage was skipped.
   - Do not change SEO generation, selection, or bulk UI behavior beyond status/debug visibility.

6. Verify with the uploaded reference video metadata.
   - Use the reference file as the expected visual/technical target: true portrait 9:16 after Shorts prep.
   - Confirm converted output is physically portrait dimensions, not a landscape file relying on rotation metadata.

7. Validate the result.
   - Run a build/type validation after edits.
   - Use browser verification where possible to confirm the upload dialog can preview/download the upload-ready copy before upload.
   - Report exactly what the logs prove: whether conversion skipped, failed, produced landscape, produced portrait but was not used, or uploaded correctly.

## Expected outcome
After implementation, one publish attempt will produce unambiguous evidence for every stage:

```text
Original generated MP4 details logged.
Validation started.
Conversion started.
Conversion completed.
Upload-ready MP4 created.
Upload-ready MP4 validated.
USING FILE FOR UPLOAD: <prepared path or original URL>
Converted = true/false
Upload uses upload-ready MP4.
Upload completes or fails with the exact failing stage.
```

If the converted upload-ready file exists, the upload dialog will let you preview/download that exact file before upload, so we can immediately tell whether the bug is conversion output or upload flow.