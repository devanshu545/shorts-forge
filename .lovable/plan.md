# Long Video → Shorts: Full Stability Rewrite

The pipeline has been patched repeatedly and is now unreliable: jobs stall at 15%, UI shows contradictory states, and clips never appear. Rather than another patch, this plan replaces the fragile parts with a single deterministic path and verifies it end-to-end.

## 1. Root causes to eliminate

From auditing `src/routes/_authenticated/split.tsx`, `src/lib/splitter.functions.ts`, `src/lib/ffmpeg-splitter.client.ts`, `scripts/splitter-runner.mjs`, and `src/routes/api/public/splitter/*`:

- **Two parallel processing paths** (browser FFmpeg + native worker) racing on the same job row → contradictory statuses.
- **Client-driven status writes** (UI sets `queued`/`processing`/`ready` directly) competing with worker writes → "Done" while nothing was produced.
- **No single owner of state**. `status`, `progress_percent`, `clips_generated`, and local UI state disagree.
- **Worker dispatch is best-effort** (GitHub Actions ping with no confirmation). If the runner never boots, the job sits at 15% forever.
- **No heartbeat enforcement on the client**. Stale detection exists in SQL but the UI never surfaces it, so users see "Processing" indefinitely.
- **Signed URLs stored at creation time** expire, breaking Library preview/download and YouTube upload.
- **YouTube upload has no Shorts-format preflight** on a fresh URL.

## 2. Single deterministic state machine

One column (`long_videos.status`) is the source of truth. Only these transitions are legal, and only the server writes them:

```text
draft
  └─(source upload confirmed)→ uploaded
       └─(worker claim, atomic)→ processing
            ├─(heartbeat < 90s, clip registered)→ processing
            ├─(all clips verified)→ ready
            ├─(worker error, attempts<3)→ failed_retryable ─(user retry)→ uploaded
            └─(attempts≥3 OR fatal)→ failed_final
```

Rules:
- Client can only move `draft → uploaded` (via a confirm endpoint after the storage upload finishes).
- Only the worker (via `claim_next_long_video_job`) moves `uploaded → processing`.
- Only `finish.tsx` moves to `ready` / `failed_*`, and only after verifying clips exist in storage and DB.
- Any write outside these transitions is rejected server-side.

## 3. Processing: native worker only

Browser FFmpeg is removed from the production path entirely (kept only as a dev-only debug tool behind a flag). All jobs run on the GitHub Actions splitter runner. This ends the browser/native race, the memory crashes, and the "works on my machine" variance.

- `split.tsx` uploads the source, calls `confirmSourceUpload`, and then only reads job state. It never runs FFmpeg, never writes status.
- `scripts/splitter-runner.mjs` is the only producer of clips. It heartbeats every 15s, retries transient failures 3×, and always calls `finish` in a `finally`.
- If the runner does not heartbeat within 90s of `processing`, `mark_stale_long_video_jobs` flips the job back to `failed_retryable` and the user (or auto-retry) requeues.

## 4. Dispatch reliability

- On `uploaded`, the server enqueues via GitHub Actions AND records `dispatched_at`.
- A lightweight cron (pg_cron every minute) calls `/api/public/splitter/tick` to (a) recover stale processing jobs and (b) re-dispatch `uploaded` jobs older than 2 minutes with no worker claim.
- This guarantees no job sits in `uploaded` forever because a webhook was lost.

## 5. Fresh URLs everywhere

- Remove reliance on stored signed URLs for playback/download/YouTube.
- Add `getFreshClipUrl(clipId)` and `getFreshThumbUrl(clipId)` server functions that sign from `video_storage_path` on demand (24h TTL, generated at read time).
- Library, download button, and YouTube upload all call these before use.

## 6. YouTube Shorts preflight

Before upload:
1. Fetch fresh signed URL.
2. `ffprobe` (server-side) to confirm `height > width`, `duration ≤ 60.5s`, H.264/AAC.
3. If not conformant, run a single server-side normalize pass (native runner, not browser).
4. Force `#Shorts` in title/description/tags.
5. Resumable upload; write result to `videos.youtube_*` fields atomically.

## 7. Verification gate before `ready`

`finish.tsx` will only mark `ready` when, for the job:
- `videos` row count ≥ 1 AND matches `clips_generated`.
- Every clip row has non-null `video_storage_path` AND the object exists in storage (HEAD check).
- Every clip has a thumbnail path that exists.
- Each clip's `duration_seconds` ≤ 60 and aspect is 9:16 (recorded by runner via ffprobe).

Otherwise → `failed_retryable` with a specific `failure_code`.

## 8. UI: read-only, backend-driven

`split.tsx` and `library.tsx` become pure views over the DB:
- Subscribe via Supabase realtime to `long_videos` and `videos`.
- Show `progress_stage`, `progress_percent`, and heartbeat age (`now - last_progress_at`). If age > 90s while `processing`, show "Recovering…" not "Processing".
- Retry button only enabled on `failed_retryable`.
- No local status state, no client-side FFmpeg, no optimistic writes.

## 9. Automated end-to-end regression suite

Add `scripts/e2e-splitter.mjs` runnable locally and in CI. It uses Playwright + fixture videos to run these scenarios sequentially and asserts final DB state:

1. Small landscape MP4 (10s).
2. Medium landscape (2min).
3. Large landscape (10min).
4. Already-vertical Shorts-shaped MP4.
5. Three consecutive jobs.
6. Retry after simulated worker crash (kill runner mid-job).
7. Refresh browser mid-processing (state must survive).
8. Interrupted upload (abort + resume).
9. YouTube upload preflight on a non-conformant clip.

Each scenario asserts: final `status='ready'`, expected clip count, all storage objects exist, fresh URLs return 200, thumbnails present, duration ≤ 60, aspect 9:16. Any failure blocks completion.

## 10. Files changed

- **DB migration**: add `dispatched_at`, `heartbeat_age_seconds` view, tighten status CHECK, add trigger rejecting illegal transitions.
- **Rewrite**: `src/routes/_authenticated/split.tsx` (read-only), `src/lib/splitter.functions.ts` (add `confirmSourceUpload`, `retryJob`, `getFreshClipUrl`).
- **Remove from prod path**: `src/lib/ffmpeg-splitter.client.ts`, `src/lib/shorts-safe.client.ts` usage in split flow.
- **Harden**: `scripts/splitter-runner.mjs` (heartbeat loop, retries, ffprobe validation, finally-finish).
- **Endpoints**: `tick.tsx` (add cron re-dispatch), `progress.tsx`, `complete.tsx` (idempotent), `finish.tsx` (verification gate), new `confirm-upload.tsx`.
- **YouTube**: `src/lib/youtube-upload.server.ts` (fresh URL + ffprobe preflight + normalize).
- **Library**: `src/routes/_authenticated/library.tsx` (fresh URLs, realtime).
- **New**: `scripts/e2e-splitter.mjs` + fixtures under `scripts/fixtures/`.
- **Cron**: pg_cron entry hitting `/api/public/splitter/tick` every minute.

## 11. Completion criteria

Marked done only when `scripts/e2e-splitter.mjs` passes all 9 scenarios twice in a row with zero manual intervention, and a manual run of one real user video produces a Shorts-format clip that uploads to YouTube successfully.
