## Goal

Make it visually and log-provably true that every YouTube upload goes through the isolated Shorts-preparation layer, and that the preview shows the exact bytes that will be uploaded. No changes to generation, AI, workers, queue, DB, storage, library, downloads, auth, or existing APIs.

## What already exists (do not change)

- `src/lib/shorts-ready.client.ts` — client-side ffmpeg.wasm cover-style 1080×1920 re-encode with pre/post MP4 probe, `+faststart`, `rotate=0`, AAC 128k, H.264 [high@4.1](mailto:high@4.1).
- Server guardrail in `src/lib/youtube-upload.server.ts` that refuses non-portrait bytes and aborts when a prepared copy was expected.
- `createShortsReadyUploadTarget` staging path so the converted Blob is uploaded via a signed URL and passed to YouTube by `preparedStoragePath`.

The layer is wired. The remaining risk is that the dialog can enter upload without the prepared copy actually being the source, and the user has no reliable visible proof.

## Scope of this change (isolated post-generation only)

1. `UploadToYouTubeDialog.tsx` — tighten the two-step flow so it is impossible to upload the original landscape file:
  - Auto-run `prepareShortsReadyBlob` as soon as the dialog opens (once), storing the prepared Blob + object URL in state.
  - The `<video>` element in the dialog binds to the prepared object URL only. While preparation is in progress, show a spinner instead of the original landscape file — never show `video.video_url` as a fallback preview.
  - "Upload Now" is disabled until `preparedUpload` exists and its `uploadProbe` passes `isPhysicalPortraitShort` + duration ≤ 60.5s.
  - Keep the existing "Download upload-ready MP4" link so the user can byte-verify externally.
2. `OneClickPublishButton.tsx` and `BulkPublishPanel.tsx` — same handoff invariant already in place; add one extra assertion right before calling `uploadVideoToYouTube`: if `prepared.reused === false` and `preparedStoragePath` is falsy, throw before hitting the server. (Already present; verify and keep.)
3. Logging cleanup (already emitted, keep as-is):
  - `Original generated MP4 details logged.`
  - `Validation started.` / `Conversion started.` / `Conversion completed.`
  - `Upload-ready MP4 created.` / `Upload-ready MP4 validated.`
  - `USING FILE FOR UPLOAD: <path|url>` and `Converted = true|false`.
4. No server changes. No storage/schema changes. No generation-pipeline changes.

## Verification

- Build succeeds (Vite/TSS typecheck).
- Open the upload dialog on a known-landscape generated clip; confirm:
  - Preview player shows portrait 1080×1920 blurred-bg framing (not the landscape source).
  - Downloaded "upload-ready MP4" opens as physical portrait in any player.
  - Console shows the full log sequence ending in `USING FILE FOR UPLOAD: <staged path>` and `Converted = true`.
  - "Upload Now" is disabled until preparation finishes.
- Repeat on a clip that is already 1080×1920 portrait: log shows `reused: true`, no ffmpeg run, and preview equals original.

## Rollback

If anything regresses, revert `UploadToYouTubeDialog.tsx` to the current two-button flow. No other file is touched, so removing this layer is a single-file revert.

## Files touched

- `src/components/UploadToYouTubeDialog.tsx` (preview binding + auto-prepare + gated Upload button)
- (verify only, no edit expected) `src/components/OneClickPublishButton.tsx`, `src/components/BulkPublishPanel.tsx`  
  
`MAKE SURE TO THE GRNARATED SHORTS IN LONG TO SHORTS SECTION IS IN 9:16 FORMAT AND READY TO UPLOAD IN YOUTUBE SHORTS SECTION NOT IN LONG VIDEO SECTION DO WHATEVER IT TAKES BUT MAKE SURE THERE SHOULD NOT BE PROBLEM IN WORKING PIPELINE`
- &nbsp;