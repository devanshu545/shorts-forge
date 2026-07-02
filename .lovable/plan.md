# Plan: Simpler stories + real hands-off daily auto-upload

## Honest reality check first (please read before approving)

You asked for **3 shorts uploaded every day even when your laptop is off**. The current pipeline **cannot** do that today, and I don't want to lie to you and burn your credits. Here's why and how I'll fix it:

- The video is stitched in **your browser** (Canvas + MediaRecorder + WebAudio). If the tab is closed, nothing renders. No stitching = no upload.
- Cloudflare Workers (where our server functions run) **cannot run ffmpeg** or a headless browser. So we can't move the stitcher to our own backend for free.
- The only genuinely free way to render + upload every day with the laptop off is an **external free worker** on a schedule.

**Solution:** a free **GitHub Actions** cron workflow (2000 free minutes/month, more than enough for 3×5-min renders/day = ~450 min/month, works for years). It calls our app's API, renders with ffmpeg, and uploads to YouTube. Nothing to install, nothing to pay, runs on GitHub's servers.

If you don't want GitHub Actions, the only free alternatives are: (a) leave the browser tab open, or (b) accept that "daily auto-upload" requires a $0-but-external runner somewhere. Tell me and I'll adapt.

---

## What I'll build

### 1. Simpler, more engaging English + more logical stories
- Tighten the Lovable AI script prompt: **grade-3 reading level**, short words, no jargon, one clear feeling per scene, clear cause→effect between scenes 1→2→3→4, satisfying payoff in scene 4 + curiosity hook for "part 2".
- Add a "logic pass": a second cheap Lovable AI call that reads the 4 scenes and rewrites anything that doesn't follow from the previous scene. Same free model.
- TTS voice defaults to `alloy` at slightly slower rate for clarity.

### 2. Trending topics (free)
- Pull **Google Trends daily trending searches** via the public RSS feed (`trends.google.com/trending/rss?geo=US`) — no key, no cost.
- Also mix in **YouTube Shorts trending** via the YouTube Data API `videos.list?chart=mostPopular&videoCategoryId=…` (uses the OAuth token you already have — free quota).
- A new server function `pickTrendingTopic()` picks one, biases toward animal/kid-friendly/funny angles that fit our Pixar-style character (avoids politics/news that get demonetized).

### 3. SEO-optimized metadata (already partially there; make it real)
- Extend the existing `MetadataSchema` step to generate:
  - **Title**: <60 chars, front-loaded keyword, 1 emoji max.
  - **Description**: first 150 chars = hook + keyword; then 3-line summary; then hashtags block; then a "🔔 Subscribe for Part 2" CTA.
  - **Tags**: 15–20, mix of broad + long-tail, all under YouTube's 500-char total tag limit.
  - **Hashtags**: exactly 3 in description (YouTube shows first 3 above title) + `#shorts` always.
- **Thumbnail**: Pollinations render of the scene-4 keyframe with big bold 2–3 word overlay text drawn client-side (or server-side via the worker with `sharp`-free canvas polyfill). Uploaded to the `thumbnails` bucket, set via YouTube API `thumbnails.set`.

### 4. New "Auto-Pilot" schedule section
New page `/_authenticated/autopilot` (rename or sit next to `/schedule`):
- Slider: **videos per day** (1–5, default 3).
- Time picker: "post at best times" (default 9am, 1pm, 7pm local — proven Shorts peaks) OR let user pick 3 slots.
- Topic mode: **Trending (auto)** / **My niche** (textarea) / **Mix**.
- Privacy: public / unlisted.
- One **Apply** button. That's it. Writes an `autopilot_settings` row (new table, 1 row per user).

### 5. Hands-off daily worker (GitHub Actions)
New file `.github/workflows/autopilot.yml` in this repo:
- Cron: every hour on the hour.
- Job steps:
  1. Checkout repo.
  2. `bun install`, install `ffmpeg` (1 apt line, ~5s).
  3. Run `scripts/autopilot-runner.ts`: hits our `/api/public/autopilot/tick` endpoint with a shared secret, gets back the list of due videos to render for all users.
  4. For each due slot: fetch script + 4 Pollinations images + 4 Lovable TTS MP3s, render with **ffmpeg** (Ken Burns via `zoompan` filter, audio concat, watermark overlay, end-card), then POST the finished MP4 + metadata back to `/api/public/autopilot/upload` which uploads to YouTube via the stored refresh token.
- No secrets in code — one GitHub Actions secret: `AUTOPILOT_SECRET` (matches a Lovable Cloud secret of the same name).
- **Result:** your laptop is off, GitHub renders + uploads. 3/day × 30 days = **90 videos/month**, exactly what you asked.

### 6. New server endpoints (Cloud, free)
- `POST /api/public/autopilot/tick` — auth by shared secret. Returns `{ jobs: [{userId, slot, topic, ...}] }` for all users whose next slot is due in the current hour.
- `POST /api/public/autopilot/upload` — auth by shared secret. Accepts rendered MP4 bytes + metadata, uploads to that user's YouTube, saves row in `videos` table, sends notification.
- `pickTrendingTopic()` helper called during tick.

### 7. DB additions (one small migration)
- `autopilot_settings(user_id pk, videos_per_day int, slot_times text[], topic_mode text, niche text, privacy text, enabled bool, updated_at)`.
- `videos.autopilot_slot timestamptz` so we never double-render the same slot.

---

## Cost & sustainability report

| Piece | Provider | Cost per video | Cost per day (3 videos) | Cost per month (90 videos) | Long-term risk |
|---|---|---|---|---|---|
| Script + logic pass + metadata | Lovable AI (Gemini free tier) | ~0 (well under free monthly allowance) | ~0 | ~0 | Low — free tier is stable |
| Trending topic pick | Google Trends RSS + YouTube API | $0 | $0 | $0 | Low — public endpoints |
| 4 keyframes | Pollinations.ai (public Flux) | $0 | $0 | $0 | Medium — public endpoint could rate-limit; we cache + retry |
| 4 narration MP3s | Lovable AI TTS (`gpt-4o-mini-tts`) | uses your Lovable credits — small (~seconds of audio each) | small | small; **watch this one** | Medium — if Lovable removes free TTS we'd swap to browser `SpeechSynthesis` (lower quality but $0) |
| Video render | GitHub Actions (ffmpeg) | $0 | ~15 min compute | ~450 min of 2000 free | Very low — GitHub free tier has been stable for years |
| YouTube upload | YouTube Data API | $0 | uses ~4800 of 10000 daily quota units | fits daily quota | Low — quota resets daily |
| Storage | Lovable Cloud Storage | tiny (MP4 ~5MB) | ~15 MB | ~450 MB / month | Fine within free tier |
| Lovable credits (agent building this) | You already paid | one-time build cost | 0 after build | 0 after build | — |

**Runtime cost per day: ~$0** (only Lovable AI TTS pings your free monthly Lovable allowance — a few cents worth at most; if you go over the free allowance the pipeline auto-falls-back to browser `SpeechSynthesis` and stays $0).

**Will this work for months?**
- GitHub Actions free tier: yes, indefinitely.
- Pollinations: has been up and free since 2023; if it ever dies we swap to another free image endpoint (Unsplash keyword + Ken Burns still works, just less "Pixar").
- YouTube API quota: 10 000 units/day; each upload = ~1600 units, so 6 uploads/day is the ceiling per channel. 3/day is safe.
- Lovable TTS: has a monthly free cap; we log usage and toast you before it runs out.

**One month from now: ~90 videos on your channel, assuming YouTube doesn't manually flag the channel for AI content (unlikely with kid-friendly animal shorts).**

---

## Files I'll touch

```text
new  .github/workflows/autopilot.yml
new  scripts/autopilot-runner.ts
new  src/routes/api/public/autopilot/tick.tsx
new  src/routes/api/public/autopilot/upload.tsx
new  src/routes/_authenticated/autopilot.tsx
new  src/lib/autopilot.functions.ts
new  src/lib/trending.server.ts
edit src/lib/animation/character-short.functions.ts   simpler-english prompt + logic pass
edit src/lib/media.functions.ts                       SEO metadata upgrade + thumbnail generator
edit src/components/app-sidebar.tsx                   add Autopilot link
migration: autopilot_settings table + videos.autopilot_slot col + grants + RLS
secret: generate AUTOPILOT_SECRET (I'll use generate_secret, no user input needed)
```

You'll do exactly two things after I ship:
1. In your GitHub repo → Settings → Secrets → add `AUTOPILOT_SECRET` (I'll show you the value).
2. Enable GitHub Actions on the repo (one click).

Everything else — trending topic pick, script, render, upload, SEO, thumbnail — is automatic.

## Approve?

If you're good with the GitHub Actions approach, hit approve and I'll build it. If you want a different runner (Modal, Render, Fly, or "just keep the browser tab open"), tell me and I'll re-plan.
