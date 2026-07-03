## Plan: Server-Triggered Autopilot + Long-Video → Shorts Splitter

### Part 1 — Server-triggered GitHub workflow

**Secret wiring**
- Reuse the existing `GITHUB_FINE_GRAINED_PERSONAL_ACCESS_TOKEN` secret (already stored). Also mirror it as `GITHUB_DISPATCH_TOKEN` for a clearer name, plus store `GITHUB_REPO=devanshu545/shorts-forge` via `set_secret`. No user form needed.

**New server helper** `src/lib/github-dispatch.server.ts`
- `triggerAutopilotWorkflow({ forceTest }: { forceTest: boolean })` → POSTs to `https://api.github.com/repos/devanshu545/shorts-forge/actions/workflows/autopilot.yml/dispatches` with `Authorization: Bearer <token>` and body `{ ref: "main", inputs: { force_test: "true"|"false" } }`.
- Returns `{ ok, status, message }`; surfaces GitHub error bodies for debugging.

**New protected server fn** in `src/lib/autopilot.functions.ts`
- `triggerWorkflowNow` (uses `requireSupabaseAuth`, calls helper with `forceTest: true`).
- Also add `dispatchDueSlotNow` used by the health card "Any moment now…" state — same helper, `forceTest: false`.

**UI wiring** in `src/routes/_authenticated/autopilot.tsx`
- Replace the existing "Run Workflow (GitHub)" instruction/link with a real button that calls `triggerWorkflowNow` via `useServerFn`, shows toast with dispatch status, then polls `getAutopilotHealth` for 60s to reflect the new run.
- Health card gains a "Trigger now" button when a slot is overdue > 2 min.

**Heartbeat/health**
- No schema change. Health already reads `autopilot_heartbeats` via `supabaseAdmin`. Add a "Last dispatch" field to the health card sourced from a new `autopilot_dispatches` lightweight log (optional — can skip and just rely on GitHub run URL returned by dispatch API; keeping it simple: skip the extra table, show returned run info in a toast + link to Actions page).

**Success criteria**
- Clicking Run Workflow in the app returns 204 from GitHub, the Actions run appears within seconds, heartbeat updates, and a Short uploads without opening GitHub.

---

### Part 2 — Long MP4 → multiple Shorts splitter

**Where**
- New route: `src/routes/_authenticated/split.tsx` ("Long → Shorts"). Sidebar entry added in `src/components/app-sidebar.tsx`.

**Upload path (client)**
- Drag-drop MP4 (up to ~500 MB). Upload directly to Supabase `videos` bucket at `long-source/<userId>/<uuid>.mp4` using resumable client upload; store metadata row in a new `long_videos` table (id, user_id, source_path, duration, status, created_at).

**Server-side split** — runs on GitHub Actions worker (ffmpeg already installed there)
- New public route `src/routes/api/public/splitter/tick.tsx` (OIDC-authorized like autopilot). Returns next queued `long_videos` job with a signed download URL + user preferences.
- New script `scripts/splitter-runner.mjs`:
  1. Downloads source MP4.
  2. Runs `ffprobe` to get duration.
  3. Detects scenes (`ffmpeg -vf select='gt(scene,0.4)'`) OR falls back to fixed windows.
  4. Chooses N clips of 30–59 s (user configurable: 30/45/59, default 55).
  5. For each clip: `ffmpeg -ss X -to Y -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -crf 20 -preset veryfast -c:a aac -b:a 128k -movflags +faststart` → vertical 1080×1920 Short.
  6. Uploads each clip to `videos` bucket, creates a `videos` row (status=`ready`, `source: "split"`, links back to `long_video_id`).
- New GitHub workflow `.github/workflows/splitter.yml` (cron every 10 min + workflow_dispatch), invoked on demand by a new server fn `triggerSplitterWorkflow` (same dispatch helper).

**UI**
- Split page shows: upload zone, per-video job status, list of generated Shorts with preview + "Upload to YouTube" button (reuses existing `UploadToYouTubeDialog`).
- Options before submit: clip length (30/45/59 s), max clips (1–10), auto-caption toggle (adds burned karaoke captions using existing caption renderer — optional v2).

**DB migration**
```sql
create table public.long_videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_path text not null,
  duration_seconds int,
  clip_length int not null default 55,
  max_clips int not null default 5,
  status text not null default 'queued',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- GRANTs + RLS (owner-only), plus link column on videos: alter table public.videos add column long_video_id uuid references public.long_videos(id) on delete set null;
```

**Success criteria**
- Upload a 5-min MP4 → within ~3 min, 5 vertical 1080×1920 Shorts appear in library, each playable, each uploadable to YouTube via existing dialog.

---

### Out of scope (for this plan)
- Auto-captioning of split clips (can be added in a follow-up).
- Trimming inside the browser (ffmpeg.wasm) — too slow/OOM for long MP4s; server path is more reliable.
