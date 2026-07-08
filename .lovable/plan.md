
# Post-generation "Shorts-ready" conversion (client-side, ffmpeg.wasm)

## Goal
Guarantee every MP4 that leaves the app for YouTube is a real vertical 1080x1920 H.264/AAC file — not a landscape file with a rotation matrix — without touching the existing generation pipeline.

## Scope guardrails (unchanged)
`ffmpeg-splitter.client.ts` clip generation, cinematic filter chain, `splitter.functions.ts`, `media.functions.ts` render/save paths, worker, queue, DB, storage, library reads, downloads, progress, autopilot rendering, auth. The generated MP4 in storage stays byte-identical.

## Where the new stage runs
Client-side in the browser tab that triggers upload (Upload dialog + BulkPublishPanel), using the same ffmpeg.wasm instance already loaded for splitting. Zero new infra, no server changes, no impact on autopilot rendering.

## Flow (per clip, only on upload)

```text
[Upload clicked]
      |
      v
Fetch generated MP4 from video_url  ->  Uint8Array
      |
      v
validateShortsMp4()  (already exists, extended)
      |
      +-- ok + faststart-only -> use existing bytes (no re-encode)
      |
      +-- rotation-metadata only -> existing shorts-rotate-fix (no re-encode)
      |
      +-- real landscape / wrong dims / codec / duration edge -> RE-ENCODE via ffmpeg.wasm
                                                                            |
                                                                            v
                                                          upload-ready copy in memory
      |
      v
Upload to YouTube (existing uploadVideoToYouTube server fn)
```

The original file in Supabase Storage is never overwritten. The upload-ready copy exists only in browser memory for the duration of the upload.

## New file: `src/lib/shorts-ready.client.ts`
Single exported function:

```ts
convertToShortsReady(sourceUrl: string, opts: {
  onProgress?: (pct: number, label: string) => void,
  signal?: AbortSignal,
}): Promise<{ file: Blob, reused: boolean, reason: string }>
```

Steps inside:
1. `fetch(sourceUrl)` -> bytes.
2. Run `validateShortsMp4` (server helper is pure JS, safe to import in browser too — no node built-ins used; if not, mirror the check in a `.client.ts` twin).
3. If `ok` and no faststart needed -> return `{ reused: true }`.
4. If only faststart / rotation metadata -> patch in-memory (pure JS) and return.
5. Otherwise call ffmpeg.wasm with the cover-style vertical filter (single pass, single output):

```text
-vf "scale=1080:1920:force_original_aspect_ratio=increase,
     crop=1080:1920,split=2[bg][fg];
     [bg]scale=1080:1920,boxblur=20:2,eq=brightness=-0.08[bgblur];
     [fg]scale='if(gt(a,9/16),1080,-2)':'if(gt(a,9/16),-2,1920)'[fgs];
     [bgblur][fgs]overlay=(W-w)/2:(H-h)/2,format=yuv420p"
-c:v libx264 -profile:v high -level 4.1 -preset veryfast -crf 20
-pix_fmt yuv420p -r 30 -movflags +faststart
-c:a aac -b:a 128k -ar 44100 -ac 2
```

Reuses the existing shared `getFFmpeg()` instance (export it from `ffmpeg-splitter.client.ts` or re-init locally — plan is to add a tiny `getSharedFFmpeg()` export without changing the splitter's own usage).

Progress mapped through `onProgress` for the dialog's progress bar.

## Wiring (minimal UI touches, no logic change)

**`src/components/UploadToYouTubeDialog.tsx`** — inside `run()`, before calling `upload({...})`:
- Call `convertToShortsReady(video.video_url)`.
- If `reused === false`, upload the returned Blob instead of the storage URL. This requires `uploadVideoToYouTube` to accept an optional client-provided blob.

**`src/components/BulkPublishPanel.tsx`** — same call per selected row before its upload step.

## Server change (tiny, additive)

`uploadVideoToYouTube` currently fetches bytes from `video_url` server-side. Add an optional `uploadUrl` (signed temp upload path) OR simpler: create a **new** server fn `uploadPreparedVideoToYouTube` that accepts the raw bytes (base64 or multipart via server route) — bytes come from the client's converted Blob. Existing `uploadVideoToYouTube` stays unchanged for any caller not on the new path (autopilot etc.).

Cleaner alternative I'll use: a server route `POST /api/upload/shorts-ready` that streams the client Blob body straight into the existing YouTube resumable upload logic (refactored into a shared helper that both entry points call). Existing behavior for `uploadVideoToYouTube` untouched.

## Autopilot
Autopilot runs headlessly on the GitHub runner and can't use ffmpeg.wasm. It keeps the current behavior (rotation-metadata fix + faststart already added). If the runner ever needs the full re-encode, that's a follow-up — out of scope here per user's "browser via ffmpeg.wasm" choice.

## Validation after conversion
Before returning from `convertToShortsReady`, run `validateShortsMp4` on the produced Blob and assert: portrait, displayWidth 1080, displayHeight 1920, duration ≤ 60.5s, codec avc1, audio mp4a, faststart. If any check fails, throw — caller shows the error, upload aborts, nothing is sent to YouTube.

## Regression protection
- New files only + additive server route + <10 lines added in two UI files.
- Feature is gated: if `convertToShortsReady` throws, the dialog surfaces the error and does NOT fall back to uploading the bad file (per user's "recognized as Short" requirement).
- Removal path: delete `shorts-ready.client.ts`, delete the new route, revert the two `await convertToShortsReady(...)` lines. Everything else is untouched.

## Files

Created:
- `src/lib/shorts-ready.client.ts`
- `src/routes/api/upload/shorts-ready.tsx` (server route accepting the converted Blob and running the existing YouTube resumable upload)
- `src/lib/youtube-upload-core.server.ts` (extracted from `youtube-upload.server.ts` — pure refactor, same behavior, so both entry points share one code path)

Edited (minimal):
- `src/components/UploadToYouTubeDialog.tsx` — one `await convertToShortsReady(...)` + progress hookup
- `src/components/BulkPublishPanel.tsx` — same call inside the per-row upload loop
- `src/lib/ffmpeg-splitter.client.ts` — export `getFFmpeg` (single line) so the new module reuses the loaded instance
- `src/lib/youtube-upload.server.ts` — delegate to `youtube-upload-core.server.ts` (behavior unchanged)

Explicitly untouched: generation pipeline, splitter, media.functions, workers, autopilot, DB, storage writes, library, downloads, auth, all other UI.
