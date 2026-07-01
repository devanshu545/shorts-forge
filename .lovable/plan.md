
# ShortForge — Build Plan

A YouTube Shorts automation app: script → voiceover → 9:16 AI video → captions → library → scheduled auto-generation → real YouTube channel analytics.

---

## Stack

- **Frontend**: TanStack Start (React 19 + Vite) — the current project template.
- **Backend for AI/YouTube calls**: TanStack `createServerFn` handlers (keeps API keys server-side, no separate deploy).
- **Persistence**: Firebase (your choice) — Firestore for metadata, Firebase Storage for MP4/MP3 files, Firebase Auth for user login.
- **AI**:
  - Scripts / captions: Lovable AI Gateway → `google/gemini-3-flash-preview`
  - Video: Lovable AI Gateway → `google/veo-3.1` (or `veo-3.1-fast`)
  - Voiceover: Lovable AI Gateway TTS
- **YouTube data**: Your OAuth client → YouTube Data API v3 + YouTube Analytics API.
- **Scheduling**: Firebase Cloud Functions with Cloud Scheduler (requires Firebase **Blaze** plan — pay-as-you-go, essentially free for personal volume).

---

## Reality checks before we start

1. **Nothing here is $0.** Veo 3.1 via Lovable AI Gateway is billed from your Lovable workspace credits (~$0.30–0.40 per short clip). Puter.js does not currently expose Veo — that "free Veo" claim isn't real. This is the cheapest legitimate path.
2. **Firebase Blaze plan required** for Cloud Functions + Scheduler. Free tier can't run server-side cron. If you refuse Blaze, scheduling will not work reliably.
3. **You'll need to paste** a few things once we start building:
   - Firebase web config (apiKey, authDomain, projectId, storageBucket, appId) — public, safe to commit
   - Firebase service account JSON — stored as a secret for server-side Admin SDK
   - Add redirect URI `https://<your-lovable-domain>/api/auth/youtube/callback` to your Google OAuth client
4. **Reference video** (the uploaded MP4) sets a visual bar. Veo 3.1 can approach it for short clips but won't perfectly clone its style — I'll tune the prompt template to get close.

---

## Features & scope

### 1. Auth
- Firebase Auth (email + Google sign-in) for app users.
- Separate "Connect YouTube" flow using your OAuth client with scopes `youtube.readonly` + `yt-analytics.readonly`. Refresh tokens stored encrypted in Firestore.

### 2. Dashboard
- Real channel stats pulled live from YouTube Data + Analytics API: subscribers, total views, watch hours (last 28 days), top videos.
- Recent generated shorts, credits/usage this month.
- Zero mock data. If not connected → clear empty state with "Connect YouTube" CTA.

### 3. Script generation
- Input: niche, tone, hook style, duration (15/30/60s).
- Gemini generates: title, hook, script (scene-by-scene), voiceover text, on-screen captions, hashtags.
- Editable before advancing.

### 4. Video generation
- Server function calls Veo 3.1 with a scene-composed prompt (9:16, 1080p, duration matched to script).
- Voiceover generated in parallel via TTS.
- Final MP4 uploaded to Firebase Storage → permanent public URL saved in Firestore. No blob URLs anywhere.
- Progress states: queued → generating video → generating audio → uploading → done. Live status via Firestore listener so refresh/tab-switch is safe.

### 5. Library
- Grid view reading from Firestore (paginated).
- Each card: thumbnail, title, duration, created date, status, actions (download, delete, upload to YouTube).
- Direct upload to connected YouTube channel via YouTube Data API.

### 6. Scheduler
- User sets: niche + cadence (daily/weekly) + time.
- Config stored in Firestore.
- Firebase Cloud Function runs on Cloud Scheduler cron, triggers the same generation pipeline server-side, notifies user (in-app + optional email).
- Works whether browser is open or not.

### 7. UI
- Dark theme: `#0A0A0F` bg, `#6C63FF` primary, glass-morphism cards, left sidebar nav (shadcn Sidebar).
- Pages: Dashboard, Generate, Library, Scheduler, Channel, Settings.

---

## Build order

1. **Foundation** — Firebase config + secrets, Firebase client/admin wrappers, auth pages, sidebar layout, dark theme tokens.
2. **YouTube OAuth** — connect flow, token storage, disconnect. Dashboard reads real channel data.
3. **Script generation** — server fn + Gemini + editable form.
4. **Video pipeline** — Veo 3.1 server fn, TTS, Firebase Storage upload, live status.
5. **Library** — Firestore-backed grid, download, delete, YouTube upload.
6. **Scheduler** — Firestore config UI + Cloud Function (I'll give you `firebase deploy` command; deploy is manual step you run once).
7. **Polish** — empty states, loading skeletons, error surfaces for 429/402 gateway errors.

---

## What I need from you to start build mode

- Confirm you'll upgrade Firebase to **Blaze** (required for scheduler). If no, I'll skip step 6 and note it.
- Confirm you'll paste Firebase web config + service account JSON when prompted.
- Confirm using existing project name (Firebase project `short-forge-web-776903451241`) is fine.

Approve this plan and I'll start with Foundation.
