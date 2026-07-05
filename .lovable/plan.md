# Stability plan: Long Video → Shorts

I will treat this as a reliability refactor, not another patch. The main change is to make the backend/native worker the primary processing path and make every job state durable, observable, retryable, and impossible to leave stuck silently.

## Goals

- Upload source video reliably with timeout/retry and clear failure states.
- Start processing only after the source upload is confirmed.
- Split and render Shorts through the native worker instead of relying on browser FFmpeg for the main production path.
- Produce valid Shorts files every time: vertical 9:16, subject centered, blurred video background, duration <= 60s.
- Make cinematic polish and 4K rendering bounded, recoverable, and non-blocking.
- Ensure generated clips appear in Split and Library consistently.
- Ensure downloads use fresh signed URLs when needed.
- Ensure YouTube uploads validate Shorts format before upload and update status cleanly.
- Add repeated end-to-end verification with multiple test videos and failure scenarios.

## Root reliability problems found so far

- The current workflow mixes browser FFmpeg, source backup upload, and native fallback. This creates race conditions where a job can be marked queued/ready/failed while another path is still running.
- Some states are too coarse: `uploading`, `queued`, `processing`, `ready`, `failed` do not record enough detail to recover safely.
- Native worker claiming is not atomic enough, so stale/retried jobs can overlap or be marked inconsistently.
- Progress is mostly UI-local or stored as generic text, so progress can freeze without the backend knowing whether the job is alive.
- The frontend can show “Uploading” or “No progress event” without a backend-backed timeout/recovery path.
- Signed URLs are stored for long periods, which can make Library previews/downloads unreliable when URLs expire.
- YouTube upload currently validates duration, but the whole path needs a single Shorts-safe preflight before upload.

## Implementation plan

### 1. Add durable job tracking and recovery fields

Update the database schema for long-video and clip processing so every job has enough state for recovery:

- `upload_started_at`, `upload_completed_at`
- `processing_started_at`, `last_progress_at`, `completed_at`
- `attempt_count`, `locked_at`, `locked_by`, `worker_run_id`
- `progress_percent`, `progress_stage`
- `failure_code`, `error_message`
- optional job event table for timeline/debug entries

This lets the app distinguish:

```text
uploading -> uploaded -> queued -> processing -> ready
                         \-> failed_retryable -> queued
                         \-> failed_final
```

### 2. Make source upload deterministic

Refactor the Split page upload flow:

- Create job row.
- Upload source video with progress, timeout, and retry.
- Confirm upload completion to the backend.
- Only then queue processing.
- If upload fails, mark the job failed immediately with a visible retry action.
- Remove the “split locally while backup upload is still running” race from the production path.

### 3. Make native worker the default production splitter

Use the existing native runner as the main path for all Long Video → Shorts jobs:

- Browser FFmpeg becomes optional/manual fallback only, not the default production path.
- Native worker performs scene selection, 9:16 centering, blurred background, cinematic polish, thumbnails, and storage upload.
- 4K rendering is queued per clip and never blocks HD clip creation.
- The worker writes progress back after every major step.

### 4. Harden public worker endpoints

Refactor splitter endpoints so they are safe and consistent:

- Atomic job claim: only one worker can claim a queued/stale job.
- Heartbeat/progress endpoint updates `last_progress_at`.
- Finish endpoint validates that at least one clip exists before marking a long video ready.
- Complete endpoint becomes idempotent per `long_video_id + clip index` so retries do not create duplicates.
- Every endpoint catches validation/runtime errors and returns structured JSON.
- Stale jobs are retried with attempt limits, then marked failed cleanly.

### 5. Make the native runner resilient

Update the runner script to:

- Report progress before/after download, probe, each clip render, upload, and finish.
- Use per-step timeouts and clear failure messages.
- Retry transient download/upload/API failures.
- Always call finish/fail in `finally` paths.
- Verify each output file with ffprobe before registering it.
- Enforce Shorts shape and duration before upload:

```text
width:height = 9:16
height > width
duration <= 60.5s
subject centered over blurred moving background
```

### 6. Fix Library preview/download reliability

Replace stale stored signed URL dependence where needed:

- Add server functions to generate fresh video/thumbnail download URLs from storage paths.
- Use fresh URLs for download and YouTube upload preparation.
- Keep stored paths as the source of truth.
- Refetch Split and Library lists automatically when backend progress changes.

### 7. Stabilize progress UI

Make progress backend-backed instead of mostly local:

- Split page polls/realtime-refreshes long video progress.
- Show last heartbeat age from `last_progress_at`.
- Show retry/fail states clearly instead of indefinite “Uploading”.
- Add “Retry processing” for retryable failed/stale jobs.
- Keep generated clips visible as soon as each clip is registered.

### 8. Harden YouTube Shorts upload

Before uploading to YouTube:

- Fetch fresh storage URL.
- Validate/convert to Shorts-safe MP4 if needed.
- Ensure `#Shorts` appears in title/description/tags.
- Keep duration <= 60 seconds.
- Upload via YouTube resumable upload.
- Mark success/failure in the video row with a clear message.

Note: YouTube’s Shorts shelf classification is controlled by YouTube after upload, but the app will upload a valid Shorts-format MP4 and link to `/shorts/{id}`.

### 9. Add verification and repeated tests

After implementation, I will verify with repeated scenarios:

- Small landscape MP4.
- Vertical MP4 already in Shorts shape.
- Larger/longer MP4.
- Retry/stale-job recovery simulation.
- Worker failure path.
- Clip appears in Split and Library.
- Download URL works.
- YouTube upload preflight works; actual upload will be tested where connection/credentials are available.

Verification will use browser automation, server route calls, worker script runs where possible, logs, and database state checks.

## Files likely to change

- `src/routes/_authenticated/split.tsx`
- `src/routes/_authenticated/library.tsx`
- `src/lib/splitter.functions.ts`
- `src/lib/media.functions.ts`
- `src/lib/youtube-upload.server.ts`
- `scripts/splitter-runner.mjs`
- `src/routes/api/public/splitter/*`
- database migration for job tracking/recovery fields and idempotency support

## Completion criteria

I will only call this complete after the workflow is verified end-to-end across repeated runs and failure paths:

- Source upload completes or fails cleanly.
- Processing starts after upload confirmation.
- Native splitting produces clips consistently.
- Shorts are vertical, centered, blurred-background, and <= 60s.
- Clips appear in Split and Library.
- Downloads work with fresh URLs.
- Progress does not freeze silently.
- Stale jobs recover or fail clearly.
- Failed jobs can be retried.
- No new runtime/build errors are present.