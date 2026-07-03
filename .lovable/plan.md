## Status of your two asks

### 1) Server-triggered Autopilot — already done in the previous turn
- `GITHUB_FINE_GRAINED_PERSONAL_ACCESS_TOKEN` + `GITHUB_REPO` (`devanshu545/shorts-forge`) are stored as backend secrets.
- `src/lib/github-dispatch.server.ts` calls GitHub's `workflow_dispatch` REST API with that PAT.
- `triggerWorkflowNow` server fn is wired into the Autopilot page:
  - "Run Workflow" button now dispatches `autopilot.yml` from the server (no more opening GitHub).
  - When a slot goes "any moment now", a **Trigger now** button appears in the health card.
- Heartbeats table + health dashboard (heartbeat age, YouTube status, next slot countdown) are live.

Nothing else needs to change for ask #1 — it's ready to test by clicking Run Workflow on `/autopilot`.

### 2) Long MP4 → multiple Shorts — what I'll build this turn

**Database (migration)**
- `long_videos` table: id, user_id, storage_path, original_filename, size_bytes, duration_seconds, clip_length (15–60s), max_clips, status (`uploaded|queued|processing|ready|failed`), clips_generated, error_message, timestamps. RLS: owner-only + service_role. GRANTs included.
- Extend `videos` with `long_video_id`, `clip_start_seconds`, `clip_end_seconds` so generated clips appear in the normal Library and reuse the existing "Upload to YouTube" dialog.

**Backend**
- `src/lib/splitter.functions.ts` — auth'd server fns: `createLongVideoUploadUrl` (signed upload URL to the `videos` bucket), `markLongVideoQueued`, `listLongVideos`, `listClipsForLongVideo`, `deleteLongVideo`.
- Public endpoints under `src/routes/api/public/splitter/`:
  - `tick` — worker pulls the next queued job (OIDC or `AUTOPILOT_SECRET`).
  - `complete` — worker POSTs each finished clip (mp4 + thumbnail as base64 → Storage → `videos` row).
  - `finish` — mark long video `ready`/`failed`.
- Extend `src/lib/autopilot-auth.server.ts` to accept OIDC tokens from `splitter.yml` in addition to `autopilot.yml`.

**Worker (runs on GitHub Actions, free)**
- `.github/workflows/splitter.yml` — installs ffmpeg, cron every 10 min, `workflow_dispatch` with optional `long_video_id`, `id-token: write` for OIDC.
- `scripts/splitter-runner.mjs` — downloads source, `ffprobe` duration, ffmpeg scene detection (`select='gt(scene,0.35)'`), picks up to `max_clips` non-overlapping windows, renders each to 1080×1920 (scale + center-crop, 30 fps, H.264 CRF 20, AAC 128k, `+faststart`), grabs a mid-frame thumbnail, POSTs back to `/complete`, then `/finish`.

**UI — new route `/split`**
- Sidebar item "Long → Shorts" (Scissors icon).
- Upload card: drop MP4, choose clip length (slider 15–60s) and max clips (1–15), progress bar, direct upload to Supabase Storage via signed URL, then queues the job and dispatches `splitter.yml` immediately.
- Job list with live status badges (uploaded/queued/processing/ready/failed) and delete.
- Clip grid for the selected job: 9:16 previews, timestamps, and the existing **Upload to YouTube** dialog per clip (you upload each Short manually, as requested).

**Testing after build**
- Upload a short sample MP4 → confirm signed-URL upload works, job goes `queued`.
- Confirm `splitter.yml` gets dispatched, ffmpeg renders 1080×1920 clips, they land in `/split` and `/library` with playable previews.
- Confirm one-click YouTube upload from a generated clip.
- Report clip count, sizes, durations, and YouTube video IDs back to you.

### Technical notes
- Cost: $0 — GitHub Actions Linux minutes are free on public repos; Supabase Storage + Data API stay in the free tier for the volumes you're pushing.
- Long videos go to the existing private `videos` bucket under `long-sources/{userId}/{uuid}.mp4`; clips go under `clips/{userId}/{uuid}.mp4` with a signed URL when viewing.
- Scene detection falls back to evenly-spaced windows if the video has few cuts, so any input (talking-head, gameplay, montage) still produces usable Shorts.
- Clip length is hard-capped at 60s to stay inside YouTube's Shorts rules.
