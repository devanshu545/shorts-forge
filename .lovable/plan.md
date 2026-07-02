## Goal

1. **Instagram Reels** upload runs on the exact same rails as YouTube — manual "Run workflow" *and* the 3/day autopilot cron will publish to **both** platforms per Short, with platform-tailored captions.
2. **Dynamic time picker** in `/autopilot`: add / remove any number of HH:MM slots; save applies immediately (cron already runs hourly, we just tighten the "is-a-slot-due" check to minute precision).

---

## Part A — Instagram integration

### What Meta requires (I'll walk you through it once, then it just works)

You'll create these once in developers.facebook.com — I'll give exact clicks in an in-app setup card:

1. **Facebook Page** connected to your **Instagram Business** account (2-min conversion inside the IG app: Settings → Account type → Switch to Business, then link the FB Page).
2. **Meta Developer App** (type "Business"), add product **Instagram Graph API**.
3. Generate a **long-lived Page Access Token** (60 days) — we auto-refresh it before expiry using the same token endpoint (Meta lets long-lived tokens be re-extended indefinitely as long as they're used).
4. Copy: **App ID**, **App Secret**, **Instagram Business Account ID**, **Long-lived Page Token**.

### What I'll build in the app

**New secrets** (stored via add_secret): `META_APP_ID`, `META_APP_SECRET`. Per-user tokens live in a new table below.

**New table** `instagram_connections` (parallel to `youtube_connections`):
- `user_id`, `ig_business_account_id`, `fb_page_id`, `page_access_token`, `token_expires_at`, `username`, `followers_count`, `updated_at`
- RLS: user reads own row; service_role full access.

**New page** `/instagram` (mirrors `/channel`): "Connect Instagram" button opens a small in-app wizard (paste IG Business Account ID + Page Token; we validate by calling `/me/accounts` and `/{ig-id}?fields=username,followers_count`). Shows connected username, follower count, disconnect button.

**Upload flow** (`src/lib/instagram-upload.server.ts`, mirrors `youtube-upload.server.ts`):
Meta's Reels upload is a **2-step container flow**:
1. `POST /{ig-id}/media` with `media_type=REELS`, `video_url=<signed Supabase URL>`, `caption=<ig caption>`, `share_to_feed=true` → returns container ID.
2. Poll `GET /{container-id}?fields=status_code` until `FINISHED` (usually 15–60s).
3. `POST /{ig-id}/media_publish?creation_id=<container-id>` → returns IG media ID.

The video must be publicly reachable — we already sign Supabase storage URLs for 7 days for YouTube, we'll reuse the same signed URL.

**Wire into existing paths** (no duplicated pipeline):
- `src/routes/api/public/autopilot/upload.tsx` — after the YouTube upload block, run a parallel IG upload block (independent try/catch, independent notification, independent error field on the video row).
- `src/routes/api/public/autopilot/run-workflow.tsx` — same: after `uploadExistingVideoToYouTube`, call `uploadExistingReelToInstagram`. Query param `platforms=yt,ig` (default both) lets manual runs target one.
- `src/components/UploadToYouTubeDialog.tsx` → rename to `PublishDialog.tsx` with two checkboxes: **YouTube** / **Instagram** (only enabled if connected), pre-checked when connected.

### Platform-tailored content (generated once, formatted twice)

`tick.tsx` planner already returns `title`, `description`, `tags`, `hashtags`, `hook`. I'll extend the plan schema with:
- `ig_caption` — expanded 2–3 sentence storytelling version of the hook + description, emoji-heavy, ending with **"Follow @<your_ig_handle> for daily stories 👇"** (handle comes from `instagram_connections.username`).
- `ig_hashtags` — up to 30 IG-native tags (`#reels #reelsinstagram #explorepage #viralreels #storytime` merged with topic tags).

YouTube keeps its existing title / description / tags / `@CraftWebStudio` CTA — nothing changes on that side.

New DB columns on `videos`: `instagram_media_id`, `instagram_permalink`, `instagram_error`, `ig_caption`, `ig_hashtags`.

### Schema columns to add (one migration)

- `videos.instagram_media_id text`, `videos.instagram_permalink text`, `videos.instagram_error text`, `videos.ig_caption text`, `videos.ig_hashtags text[]`
- `instagram_connections` table (see above) + GRANT + RLS + policy `user_id = auth.uid()`.
- `autopilot_settings.slot_minutes int[]` (parallel array to `slot_hours`, defaults to zeros for existing rows) — for HH:MM precision.

---

## Part B — Dynamic HH:MM time picker

**UI** (`src/routes/_authenticated/autopilot.tsx`):
- Replace the fixed 3-slot hour selector with a dynamic list:
  - "+ Add slot" button (no upper cap in UI; soft-warn above 10/day).
  - Each row: HH `Select` (00–23) + MM `Select` (00, 15, 30, 45) + trash button.
  - "Save" writes both `slot_hours` and `slot_minutes` arrays; toast "Schedule applied — next slot: HH:MM in your timezone".
- Health card's "Next 3 slots" already uses `computeUpcomingSlots` — I'll extend it to use minute precision.

**Backend** (`src/lib/autopilot.functions.ts` + `tick.tsx`):
- `saveAutopilotSettings` schema: add `slot_minutes: z.array(z.number().int().min(0).max(59))` matching `slot_hours` length. Zod refine: same length.
- `computeUpcomingSlots(slot_hours, slot_minutes, tz)` — build slots with minute precision.
- `tick.tsx` due-slot check: current window is "within 60 min of a slot hour"; tighten to "within ±30 min of any (h,m) slot" so a 14:15 slot fires from the 14:00 cron run (which is the closest hourly tick) — this keeps the free hourly GitHub cron and still gives you minute-level scheduling within ~30 min accuracy. If you want exact-to-the-minute, we'd need to move the GitHub workflow cron from `0 * * * *` to `*/15 * * * *`, which is still free — I'll do that in the same change so slots align to 15-min quantization exactly.

`videos_per_day` is derived from `slot_hours.length`, so we drop the separate `videos_per_day` selector.

---

## Files to change

| File | Change |
|---|---|
| `supabase migration` | new table `instagram_connections`, new columns on `videos` + `autopilot_settings.slot_minutes` |
| `src/lib/instagram-upload.server.ts` | new — Reels container + publish + poll |
| `src/lib/instagram.functions.ts` | new — connect/disconnect/getConnection server fns |
| `src/routes/_authenticated/instagram.tsx` | new — connect page mirroring `/channel` |
| `src/components/app-sidebar.tsx` | add Instagram link |
| `src/components/UploadToYouTubeDialog.tsx` → `PublishDialog.tsx` | dual-platform checkboxes |
| `src/routes/api/public/autopilot/tick.tsx` | plan schema adds `ig_caption` + `ig_hashtags`; minute-precision due check |
| `src/routes/api/public/autopilot/upload.tsx` | parallel IG upload after YT |
| `src/routes/api/public/autopilot/run-workflow.tsx` | `platforms` param, IG branch |
| `scripts/autopilot-runner.mjs` | pass through platforms flag; IG uses signed Supabase URL (no re-download) |
| `src/lib/autopilot.functions.ts` | `slot_minutes` in schema + `computeUpcomingSlots` |
| `src/routes/_authenticated/autopilot.tsx` | dynamic HH:MM slot editor + health card update |
| `.github/workflows/autopilot.yml` | cron `*/15 * * * *` for minute-precision |

---

## Cost / long-term stability

- Meta Graph API for Reels: **free**, no quota you'll hit at 3/day.
- Long-lived tokens: 60 days, auto-extended on use — I'll add a weekly refresh call in `tick.tsx` (already runs hourly) so tokens never expire silently.
- No new npm packages, no new paid services.
- If IG upload fails, YT still succeeds independently and vice versa — you're never blocked by one platform.

---

## What I need from you before I build

Just your **Instagram handle** (e.g. `@craftwebstudio`) so I can hardcode the "Follow @…" CTA into the IG caption template. Everything else (App ID, Secret, Page Token, IG Business Account ID) you'll paste into the in-app connect form after the code is live — no need to share them here.
