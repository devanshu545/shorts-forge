# How the automatic 3-shorts-a-day pipeline actually works

Short answer: it is already fully server-side. Your laptop, browser, and internet are not involved once Autopilot is ON. Here is exactly what runs, on whose machine, using whose internet — and what I will add so you can trust it without watching it.

## The moving parts (already built)

```text
GitHub Actions (cron: every hour UTC)
        │  runs on GitHub's Ubuntu VM, GitHub's internet
        ▼
scripts/autopilot-runner.mjs
        │  authenticates with GitHub OIDC (no secret needed)
        ▼
POST  https://devanshuautomation.lovable.app/api/public/autopilot/tick
        │  runs on Lovable Cloud (Cloudflare Worker), Lovable's internet
        │  ─ reads autopilot_settings for every enabled user
        │  ─ checks: is current hour one of user's slot_hours (in their TZ)?
        │  ─ if yes AND no video already exists for that slot:
        │       • plan story (Lovable AI Gateway, Gemini)
        │       • generate 4 keyframe images (Pollinations, free)
        │       • generate 4 TTS clips (Lovable AI Gateway, gpt-4o-mini-tts)
        │       • reserve a row in `videos` (status = generating_video)
        │       • return {images[], audios[], plan} as base64 to GitHub
        ▼
GitHub VM stitches with ffmpeg
        │  Ken-Burns zoom, concat, SUBSCRIBE watermark, end card, thumbnail
        ▼
POST  /api/public/autopilot/upload  (base64 mp4 + thumb)
        │  Lovable Cloud → YouTube Data API v3 resumable upload
        │  using your stored Google OAuth refresh token (auto-refreshes)
        ▼
YouTube publishes the Short, row updated to status=uploaded + youtube_video_id
```

So the answer to your three questions:

- **How does it generate without you?** Planning + images + TTS run on Lovable Cloud from a cron-triggered HTTP call. ffmpeg stitching runs on GitHub's Ubuntu runner. Nothing runs on your laptop.
- **Whose internet?** GitHub Actions' internet for the cron trigger and ffmpeg step; Lovable Cloud's internet for AI calls and the YouTube upload. Yours is never used.
- **How does it hit 3/day?** `autopilot_settings.slot_hours` (e.g. `[9, 14, 20]` in your timezone). The hourly cron checks each slot; when the current hour matches a slot and no video exists yet for that slot (unique key `autopilot_slot`), it generates and uploads one. Idempotent — reruns of the same hour won't double-post.

## Why the current setup is trustworthy, and what's still missing

Already safe:
- Slot dedupe via `autopilot_slot` column → no duplicate uploads even if cron retries.
- Scheduled runner also calls `run-workflow` with `onlyAutopilot: true` first, so any short that rendered but failed to upload last hour gets retried automatically.
- Failed generations write to `notifications` and mark the video row `failed` with the error, so nothing silently disappears.
- OAuth refresh token is stored server-side; YouTube upload code auto-refreshes access tokens.

Gaps I want to close so you can actually trust it unattended:

1. **No end-to-end proof it survives a real slot without you.** Right now you've only tested via the manual "force" button. I'll add a `dry-run scheduled` check the workflow prints every hour: which users are enabled, which slots are due, and what it would generate — visible in GitHub Actions log even on hours nothing is due.
2. **No health dashboard in the app.** I'll add an "Autopilot Health" card to the Autopilot tab showing: last successful upload time, next 3 scheduled slots (in your timezone), last 5 runs with status/YouTube link/error, and a red banner if the last 2 slots both failed.
3. **No alert if YouTube token expires or gets revoked.** I'll add a check in `tick`: if the user's Google connection is missing/expired, skip generation (don't waste credits), insert a notification "Reconnect YouTube in Settings", and surface it in the health card.
4. **No alert if GitHub Actions itself stops running.** I'll add a "last cron heartbeat" timestamp: the runner pings `/api/public/autopilot/heartbeat` every hour. The health card shows "⚠ No cron ping in 2h+" if GitHub is silent — so you notice within hours, not days.
5. **Verify one real automatic slot end-to-end.** After the above ships, I'll set one of your `slot_hours` to the next upcoming hour, publish, wait for the GitHub cron to fire naturally (not the manual button), and confirm the video appears on YouTube with the correct slot key. Then restore your original slots.

## Files I will touch

- `src/routes/api/public/autopilot/heartbeat.tsx` — new tiny endpoint, writes `autopilot_heartbeats(last_ping timestamptz)`.
- `scripts/autopilot-runner.mjs` — call heartbeat first thing every run; log a per-user "due-slot preview" line.
- `src/routes/api/public/autopilot/tick.tsx` — pre-check YouTube connection; skip + notify if missing/expired; return that in the response for GitHub log.
- `src/lib/autopilot.functions.ts` — new `getAutopilotHealth` server fn (last upload, upcoming slots, recent runs, heartbeat freshness, youtube-connection status).
- `src/routes/_authenticated/autopilot.tsx` — add "Autopilot Health" card at the top with heartbeat, next slots, recent runs, and a "Reconnect YouTube" CTA when needed.
- One migration: `autopilot_heartbeats` table + GRANTs + RLS + index on `videos(user_id, autopilot_slot)` if missing.

## Verification checklist (I will not stop until all are green)

- [ ] Publish app.
- [ ] GitHub cron fires on the next hour → Actions log shows heartbeat ping, due-slot preview, and either "no slot due" or an upload.
- [ ] Health card in the app shows fresh heartbeat within 65 min.
- [ ] Set one slot to the next hour, wait for natural cron (no manual button), confirm YouTube publish + row status `uploaded` + slot key matches.
- [ ] Restore your original slots.
- [ ] Disconnect YouTube in a test → next tick skips generation, notification appears, health card shows red "Reconnect" CTA. Reconnect and confirm green.
