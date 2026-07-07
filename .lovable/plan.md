# Goal

Make YouTube always recognize our uploads as Shorts. Do NOT touch the generation, rendering, ffmpeg, workers, queue, DB, library, or download pipelines. The only change happens between "rendered MP4 exists" and "YouTube upload starts".

# Root cause

Even when a clip is 9:16, YouTube sometimes classifies it as a regular video because one of the Shorts signals is missing at upload time:

- container/codec not clean MP4 + H.264 + AAC
- duration > 60s (edge cases: 60.02s from fragmented MP4)
- moov atom not at the start (no faststart) → slow-metadata upload path
- width ≥ height (a landscape source slipped through)
- metadata (`#Shorts` in title/description, `Shorts` tag, categoryId 24) missing

The `#Shorts` metadata piece already exists in `src/lib/youtube-upload.server.ts` (`ensureShortsHashtag`). What's missing is a **file-level validator + auto-fix** right before the upload PUT.

# Change (surgical, upload-stage only)

## 1. New file: `src/lib/shorts-validator.server.ts`

Pure-JS MP4 box parser (no ffmpeg, Worker-safe) that reads the first ~2 MB and, if needed, the last ~1 MB of the MP4 buffer already held in memory inside `uploadExistingVideoToYouTube`. Extracts:

- `ftyp` major brand + compatible brands (must include `isom`/`mp42`/`iso5`)
- position of `moov` vs `mdat` (faststart = moov before mdat)
- `tkhd` width/height (must be height > width, ratio ≈ 9:16 within 2%)
- `mvhd` duration / timescale (must be ≤ 60.0s)
- `stsd` codec fourcc for video (`avc1`/`hvc1`) and audio (`mp4a`)

Returns `{ ok: true }` or `{ ok: false, reasons: string[], needsFaststart: boolean, needsRemux: boolean }`.

## 2. New file: `src/lib/shorts-faststart.server.ts`

Pure-JS moov→front relocator (no re-encode, no ffmpeg). Standard qt-faststart algorithm:

1. Find `moov` and `mdat` top-level boxes.
2. If `moov` already precedes `mdat`, return the buffer unchanged.
3. Rewrite all `stco`/`co64` offsets inside `moov` by `+moov.size`.
4. Emit `[ftyp][moov][mdat...rest]`.

This handles the vast majority of "not recognized as Short" cases with zero quality loss and runs in <100 ms on a 50 MB file. Worker-safe: pure Uint8Array ops.

## 3. Edit: `src/lib/youtube-upload.server.ts` (only `uploadExistingVideoToYouTube` and `uploadMp4ToYouTube`)

Insert one call between "bytes loaded" and "YouTube init":

```ts
const check = validateShortsMp4(bytes);
if (!check.ok) {
  if (check.needsFaststart && !check.needsRemux) {
    bytes = faststartMp4(bytes);
  } else {
    // Hard requirements not met (wrong AR / >60s / wrong codec).
    // Do NOT silently upload a broken Short — surface a clear error
    // that names the failing check, so the user can re-render.
    throw new Error(`Cannot upload as Short: ${check.reasons.join("; ")}`);
  }
}
```

`ensureShortsHashtag`, `Shorts` tag, and `categoryId: 24` stay exactly as they are.

## 4. Also apply to `src/routes/api/public/autopilot/upload.tsx`

That route uploads bytes directly through `uploadMp4ToYouTube` via `uploadExistingVideoToYouTube`, so it inherits the fix automatically once (3) is done. No code change needed here beyond confirming the call path.

# Explicitly NOT changed

- `src/lib/ffmpeg-splitter.client.ts` (rendering / vertical-center / cinematic polish)
- `src/lib/splitter.functions.ts`
- `src/lib/media.functions.ts`
- `src/components/BulkPublishPanel.tsx`, `UploadToYouTubeDialog.tsx`, library, workers, DB schema, progress tracking
- Any UI

# Validation

1. Render a Short with the existing pipeline (no changes to that path).
2. Upload via existing button — inspect network: init call sees a moov-first MP4, PUT returns 200, YouTube Studio shows the Shorts badge.
3. Force a bad input (a landscape MP4) — upload should now fail fast with a readable error instead of silently landing as a regular video.
4. Autopilot path: run `/api/public/autopilot/upload` — same behavior.
5. Confirm build passes and no new runtime errors appear.

If (3) or any regression appears, revert `youtube-upload.server.ts` to the pre-change version — the two new files are inert on their own.  
  
Before implementing any automatic MP4 rewriting:

1. **Verify the root cause with evidence.** Determine exactly why YouTube is classifying the upload as a regular video instead of a Short. Check:
  - Final resolution and orientation.
  - Actual duration (ensure it is not slightly over 60 seconds).
  - Video codec.
  - Audio codec.
  - Container.
  - Metadata.
  - The exact file being uploaded (confirm it is the generated short, not the original source video).
  - The exact YouTube upload request.
2. **Only implement MP4 modification if validation proves it is necessary.** If the generated file is already compliant, do not rewrite or modify the MP4. Avoid unnecessary processing.
3. **Verify the upload target.** Confirm that the application uploads the generated short file and never accidentally uploads the original long video.
4. **Preserve binary integrity.** After any modification, verify:
  - File remains playable.
  - Duration unchanged.
  - No audio/video desynchronization.
  - No quality loss.
  - No corruption.
5. **Run real-world verification.** Upload multiple generated shorts and confirm they appear in the Shorts feed within YouTube Studio. If YouTube still classifies them as videos, continue investigating instead of assuming the MP4 structure is the only cause.
6. **Regression protection.** If any change causes existing uploads, downloads, rendering, or playback to fail, automatically revert that change and use a different approach.  
  
Regression Safety Requirements (Mandatory)
  This is a **zero-regression** change.
  The current Short generation pipeline is already producing correct videos. The only objective is to ensure that YouTube classifies those generated videos as **Shorts**.
  ### Absolutely do NOT modify
  Unless it is directly required for the upload-stage validation, do **not** modify:
  - Short generation
  - AI clip selection
  - Scene detection
  - Rendering
  - FFmpeg processing
  - Native worker
  - Queue
  - Upload scheduling
  - Progress tracking
  - Database schema
  - Library
  - Downloads
  - Authentication
  - Storage
  - Existing APIs
  - UI
  ### File Scope
  The implementation should remain isolated to:
  - `src/lib/youtube-upload.server.ts`
  - Any new helper files required for upload validation only
  Do not make unrelated code changes.
  ### Automatic Regression Testing
  Before considering the task complete, automatically verify that:
  - The generated MP4 is **byte-for-byte identical** to the previous output unless a validated upload-stage transformation (such as faststart relocation) is required.
  - Rendering quality is unchanged.
  - Resolution is unchanged.
  - Frame rate is unchanged.
  - Audio remains synchronized.
  - Captions remain unchanged.
  - File size changes only if required by the upload-stage fix.
  - The upload target is the generated short, never the original source video.
  - Existing download functionality still works.
  - Library playback still works.
  - Autopilot upload still works.
  - Manual upload still works.
  ### Rollback Protection
  If any modification causes:
  - New runtime errors
  - Build failures
  - Upload failures
  - Processing failures
  - Playback issues
  - Rendering differences
  - Queue failures
  - Worker failures
  - Library failures
  Immediately revert the change and choose another implementation.
  Do **not** leave the application in a partially working state.
  ### Success Criteria
  The task is complete only when:
  - The generation pipeline behaves exactly as before.
  - No existing functionality has regressed.
  - The generated file is uploaded.
  - YouTube consistently recognizes the upload as a Short.
  - No new errors have been introduced anywhere in the application.
  ---
  ### One important technical note
  Your assumption is that **YouTube uploads the video into the "Videos" tab instead of the "Shorts" tab because of the MP4**. That's **possible**, but it's **not the only possibility**.
  YouTube generally classifies a video as a Short based on factors such as:
  - Vertical orientation.
  - Duration (currently Shorts can be longer than 60 seconds in some contexts, but support varies by upload flow).
  - The actual uploaded media file.
  - Processing on YouTube's side.
  The `#Shorts` hashtag and category metadata do **not** force YouTube to classify a video as a Short. They may help discoverability, but YouTube primarily uses the uploaded media itself.
  Because of that, I think your added verification step ("verify the exact file being uploaded and confirm the generated short—not the original video—is sent") is one of the most important parts of the plan. If the wrong file is being uploaded, changing MP4 metadata won't solve the issue.