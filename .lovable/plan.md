# Goal

Make YouTube classify our uploads as **Shorts** — including when the same generated file is uploaded manually via YouTube Studio. Zero changes to the generation pipeline (upload, AI detection, scene detection, rendering, ffmpeg filters, worker, queue, DB, storage, library, downloads, progress, UI).

# Why the current fix isn't enough

`src/lib/youtube-upload.server.ts` already runs `validateShortsMp4` + `faststartMp4` before upload. But the user reports that even the **manually downloaded MP4 uploaded through YouTube Studio** is classified as a regular Video. That rules out anything YouTube-API-side (hashtag, categoryId, tags) and points at the file itself.

The current validator only reads `tkhd` width/height as raw pixels. It does NOT read:

- `tkhd` **rotation matrix** (a 1920x1080 landscape file with a 90° rotation matrix displays as 1080x1920 but YouTube's shelf classifier often ignores rotation and treats it as landscape)
- **Track edit list** (`elst`) that can shift the effective duration past 60s even when `mvhd` says ≤60s
- **Sample aspect ratio** (`pasp`) which can make a square-pixel 1080x1920 file get treated as non-vertical
- Whether the file actually plays back as vertical on a mobile player (the real test)

The most likely real cause: the rendered MP4 stores landscape sample dimensions + a rotation matrix, so YouTube's classifier sees "landscape → regular Video".

# Plan

## 1. Diagnostic-only pass first (no auto-fix change yet)

Add a `logShortsDiagnostics` call in `uploadExistingVideoToYouTube` that logs, for every upload:

- `ftyp` major + compatible brands
- `mvhd` duration (raw + timescale)
- `tkhd` width, height, **full 3x3 matrix** (to detect 90°/270° rotation)
- `elst` edits (start, duration, media_time)
- `pasp` (if present)
- `stsd` video codec fourcc + `avcC` profile/level
- `stsd` audio codec fourcc + channel count + sample rate
- `moov` vs `mdat` order
- Total file size

This runs on the exact bytes about to be PUT to YouTube, so we get ground truth for both the automatic and (via a one-off "Diagnose" button) the manual path.

**No behavior change** from this step alone — just structured `console.log` lines the user can screenshot from the edge-function log tail.

## 2. Extend the validator with the missing checks

Update `src/lib/shorts-validator.server.ts` to also parse and report:

- Rotation matrix → compute effective displayed width/height
- Edit list → compute effective playback duration
- `pasp` → warn if non-square pixels

Failing any of these adds a reason to `check.reasons` and sets `**needsRemux: true**` so the existing hard-fail path in `youtube-upload.server.ts` triggers with a specific message ("file has 90° rotation matrix; YouTube sees this as landscape — re-render or auto-fix").

## 3. Zero-quality-loss auto-fix (metadata-only, no re-encode)

For the two fixable cases where the pixel data is already correct and only the metadata lies:

- **Rotation matrix wrong**: rewrite the `tkhd` matrix to identity and swap width/height so the file declares vertical directly. Pure Uint8Array patch, no re-encode, no quality loss, no ffmpeg. New file: `src/lib/shorts-rotate-fix.server.ts`.
- **Faststart missing**: already handled by existing `shorts-faststart.server.ts`.

For anything that would need actual re-encoding (real landscape pixels, duration >60s, wrong codec), we **do not** re-encode server-side (Cloudflare Worker cannot run ffmpeg). We surface a clear error naming the failing check so the user re-renders. This preserves the "zero regression" and "no quality loss" guarantees.

## 4. YouTube music selection — honest answer, no fake feature

YouTube Data API v3 has **no endpoint to attach an audio track / YouTube Music track / Creator Music track to an uploaded Short**. Creator Music is a Studio-only UI feature; there is no public API surface. Any "solution" would be one of:

- muxing third-party audio into the MP4 ourselves (copyright/DMCA risk, not "YouTube music")
- automating the Studio UI (against ToS, unreliable)
- suggesting music that the user then attaches manually in Studio

Per the requirement "do not fake this feature", we **do not build music-attach**. We add a single sentence in the upload dialog: "YouTube does not allow attaching Creator Music via API. Add music from YouTube Studio after upload." No code paths beyond that string.

## 5. Files touched (scope)

Modified:

- `src/lib/shorts-validator.server.ts` — add rotation matrix, edit list, pasp parsing; set `needsRemux` for real problems
- `src/lib/youtube-upload.server.ts` — call new rotation-fix helper when only rotation metadata is wrong; add diagnostic logging
- `src/components/UploadToYouTubeDialog.tsx` — one-line note about music (UI text only, no logic)

New:

- `src/lib/shorts-rotate-fix.server.ts` — pure-JS `tkhd` matrix rewriter

Explicitly untouched: `ffmpeg-splitter.client.ts`, `splitter.functions.ts`, `media.functions.ts`, `BulkPublishPanel.tsx`, library route, workers, DB, storage, autopilot pipeline files, auth, UI beyond the one-line music note.

## 6. Verification

1. Generate a Short with the existing pipeline. Trigger upload. Read the new diagnostic log to confirm the actual root cause (rotation? faststart? real landscape? >60s?).
2. If rotation-metadata was the cause: confirm the auto-fix runs, YouTube Studio shows the Shorts badge, and the downloaded/re-uploaded file also lands as a Short manually.
3. If a real re-encode is required (landscape pixels / >60s): confirm we fail fast with the exact reason and the user re-renders.
4. Run the autopilot upload path (`/api/public/autopilot/upload`) — inherits the fix through the shared `uploadExistingVideoToYouTube`.
5. Confirm build passes, existing downloads still work (they read the untouched storage bytes), library playback still works, no new runtime errors.

If any regression appears, revert `youtube-upload.server.ts` and the two new files — they are inert on their own.

# Technical notes

- All new code is Worker-safe (pure `Uint8Array`), consistent with existing `shorts-*.server.ts` modules.
- `tkhd` matrix rewrite: for a rotated-landscape file, set matrix to `[1,0,0, 0,1,0, 0,0,1]` (in 16.16 / 2.30 fixed-point as MP4 spec requires) and swap the last-8-byte width/height fields. `mdat` sample data is untouched, so playback and quality are identical.
- Diagnostic logging uses one `console.log` object per upload — small, structured, easy to grep in edge-function logs.
- The music note is a static string; no new dependencies, no new state.  
  
  
  
Fallback Plan (Only if the above investigation and fixes do not resolve the issue)
  If, after implementing the diagnostic investigation and metadata-only fixes, YouTube still classifies the generated file as a regular Video, do **not** continue patching the upload logic.
  Instead, add **one final post-processing validation layer** immediately **after the Short has been completely generated** and **before any upload begins**.
  ### This layer must be completely isolated.
  It must **not** modify or interfere with:
  - Upload pipeline
  - AI clip detection
  - Scene detection
  - Rendering
  - FFmpeg processing already used for generation
  - Native worker
  - Queue
  - Database
  - Storage
  - Library
  - Downloads
  - Progress tracking
  - Existing APIs
  - UI
  The existing generation pipeline must remain exactly as it is.
  ### Purpose
  This layer exists only to verify that the **final rendered MP4** is truly YouTube Shorts–compatible.
  It should inspect the completed output and determine whether it satisfies all known Shorts media requirements.
  If it already does, **leave the file unchanged**.
  If it does not, create a **new upload-ready copy** from the generated output using the smallest possible transformation necessary.
  This transformation must:
  - Preserve visual quality.
  - Preserve audio quality.
  - Preserve captions.
  - Preserve subtitles.
  - Preserve timing.
  - Preserve clip boundaries.
  - Preserve cinematic effects.
  - Preserve blur background.
  - Preserve centered subject.
  - Preserve thumbnails.
  - Preserve filenames where practical.
  Do **not** regenerate the Short.
  Do **not** rerun AI processing.
  Do **not** rerun clip detection.
  Only prepare the already-generated output for upload if required.
  ### Verification
  The original generated file must remain untouched.
  The upload-ready copy should be created only if validation proves it is necessary.
  Before upload, verify that the upload-ready copy:
  - Has the expected vertical geometry.
  - Meets the intended Shorts duration requirements.
  - Uses the expected container and codecs.
  - Plays correctly.
  - Can be uploaded manually to YouTube Studio.
  - Is recognized by YouTube as a Short after processing.
  ### Regression Protection
  If this additional validation layer introduces any regression or instability:
  - Remove only this layer.
  - Restore the previous upload behavior.
  - Leave the existing generation pipeline unchanged.
  This fallback must be completely isolated from the working processing pipeline and should only be used if the primary investigation and metadata fixes do not resolve the classification issue.