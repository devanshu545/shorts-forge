
# ShortForge — Revised Build Plan (Supabase via Lovable Cloud)

Switching backend from Firebase to Supabase. Good news: **Lovable Cloud IS managed Supabase** — I enable it with one tool call and you get Postgres, Auth, Storage, and Edge Functions with zero config. **No URL or anon key to paste.**

---

## Stack

- **Frontend**: TanStack Start (React 19 + Vite) — current template.
- **Backend**: Lovable Cloud (managed Supabase) — auth, Postgres, Storage, Edge Functions, cron.
- **AI (via Lovable AI Gateway, uses your credits)**:
  - Scripts / SEO / hashtags → `google/gemini-3-flash-preview`
  - Voiceover → `openai/gpt-4o-mini-tts`
  - Video → Veo 3.1 (see reality check #2 below)
- **YouTube**: Your OAuth client → YouTube Data API v3 + YouTube Analytics API.

---

## Reality checks

1. **You do NOT need to paste a Supabase URL or anon key.** Lovable Cloud provisions and wires everything. If you have a separate self-managed Supabase project you specifically want to use, tell me now; otherwise Cloud is the path.
2. **Veo 3.1 availability.** Lovable AI Gateway's public model catalog currently lists chat, TTS, embeddings, and image models. Video (Veo) is not in the standard allowlist I can see. I'll wire the video-generation server function against `google/veo-3.1` per your request; if the gateway rejects it, we'll get a clear 400 and I'll surface an error + fallback path (either wait for gateway support or switch to a different provider you approve). I will not silently mock it.
3. **YouTube OAuth redirect URI.** After enabling Cloud, I'll give you the exact URL (`https://<preview-domain>/api/auth/youtube/callback`) to paste into your Google OAuth client's Authorized Redirect URIs.
4. **Cost.** Gemini scripts ~$0.001, TTS ~$0.01, Veo (if available) ~$0.30–0.40 per short. Billed to your Lovable workspace credits.

---

## Data model (Postgres, RLS on every table, `user_id = auth.uid()`)

- `profiles` — id (=auth.uid), email, display_name, avatar_url, created_at
- `videos` — id, user_id, title, script (jsonb: scenes/voiceover/captions), video_url, thumbnail_url, audio_url, duration_seconds, file_size_bytes, status (`queued|scripting|generating_video|generating_audio|uploading|ready|failed|scheduled|published`), seo_keywords[], hashtags[], description, error_message, created_at, updated_at
- `scheduled_jobs` — id, user_id, niche, tone, cadence (`once|daily|weekly`), next_run_at, last_run_at, active, video_defaults jsonb
- `youtube_connections` — user_id (pk), channel_id, channel_title, access_token (encrypted), refresh_token (encrypted), token_expires_at, connected_at
- `analytics_snapshots` — id, user_id, video_id (nullable, for channel-wide), source (`youtube`), metrics jsonb, snapshot_at

Storage buckets (private, RLS by user_id folder prefix):
- `videos/{user_id}/{video_id}.mp4`
- `thumbnails/{user_id}/{video_id}.jpg`
- `audio/{user_id}/{video_id}.mp3`

---

## Backend surfaces

- **TanStack `createServerFn`** for all app-internal calls: generate script, kick off video job, list library, connect/disconnect YouTube, fetch analytics.
- **Server routes** (`src/routes/api/…`):
  - `GET /api/auth/youtube/callback` — OAuth code exchange, store tokens.
  - `POST /api/public/cron/scheduler` — invoked by Supabase cron.
- **Supabase Edge Function `scheduler`** (deployed with the project) — runs hourly via `pg_cron`, finds due `scheduled_jobs`, enqueues generation. Works when browser is closed.
- **Supabase Edge Function `generate-video`** — long-running: calls Veo, downloads MP4, uploads to Storage, updates `videos` row. Client subscribes to that row via realtime for live status.

---

## Features & pages

1. **Auth** — Google sign-in (Lovable Cloud managed) + email/password. Auto-creates `profiles` row via trigger.
2. **Dashboard (`/`)** — real channel stats when YouTube connected (subs, 28-day views, watch hours, top shorts); recent generated shorts; credit-usage note. Clean empty state with "Connect YouTube" CTA if not connected. No mock numbers.
3. **Generate (`/generate`)** — form (niche, tone, hook style, duration 15/30/60s) → Gemini script (editable: title, hook, scene-by-scene, VO, captions, hashtags, description) → "Generate video" → live status via realtime.
4. **Library (`/library`)** — Firestore-… sorry, Postgres-backed grid, thumbnails, filters, actions: play, download, copy (title/script/description/hashtags), delete, upload-to-YouTube, manual MP4 drag-drop upload.
5. **Schedule (`/schedule`)** — create/edit/pause scheduled jobs, next-run time, history.
6. **Channel (`/channel`)** — deeper YouTube analytics for the connected channel.
7. **Settings (`/settings`)** — profile, YouTube connect/disconnect, sign out.

---

## UI

- Dark theme tokens in `src/styles.css`: bg `#0A0A0F`, primary `#6C63FF`, glass surfaces via layered `oklch` + backdrop-blur.
- Shadcn Sidebar (left nav, collapsible), glass-morphism cards, grid library, typography pair Space Grotesk display + Inter body.

---

## Build order

1. **Enable Lovable Cloud** + create schema migration (all tables, RLS, `has_role` pattern if we add roles later, buckets, storage policies).
2. **Theme + layout** — dark tokens, sidebar shell, `_authenticated` gate, auth pages (Google + email).
3. **YouTube OAuth** — callback route, token storage, connect/disconnect UI. Give you the redirect URI to whitelist.
4. **Script generation** — server fn + Gemini + editable form on `/generate`.
5. **Video pipeline** — `generate-video` edge function (Veo call, Storage upload), realtime status, TTS voiceover, SRT captions.
6. **Library** — grid, playback, download, copy actions, manual upload, delete.
7. **Dashboard + Channel** — real YouTube Data + Analytics API reads.
8. **Scheduler** — UI + `scheduler` edge function + pg_cron.
9. **Polish** — empty states, skeletons, 429/402 gateway error surfaces.

---

## What I need from you to start

- Confirm using **Lovable Cloud** (managed Supabase). If you insist on a separate self-managed Supabase, say so and I'll wire it instead.
- Understanding on Veo (reality check #2): proceed and surface a real error if unavailable.

Approve and I'll start with step 1.
