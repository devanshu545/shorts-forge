## Goal

Make every auto-uploaded Short look expensive so viewers stop scrolling, watch to the end, and subscribe to **@CraftWebStudio**. All upgrades are free, use only tools already wired in (ffmpeg + Lovable AI TTS + Pollinations), and stay stable long-term (no external paid API, no key expiry, no fragile dependency).

## Why current Shorts feel cheap

Reading `scripts/autopilot-runner.mjs` and `tick.tsx`:

1. Only 4 static images with slow Ken-Burns zoom — no motion between scenes.
2. Hard-cut concat between scenes (jarring, amateur).
3. Only text on screen is a yellow `SUBSCRIBE` box in the default ffmpeg font (looks like a 2012 meme).
4. No captions synced to the voiceover — the #1 retention killer on Shorts. Every top channel has bouncing word-by-word subs.
5. No music bed under the narration.
6. 720×1280 output.
7. No hook card in the first 1.5s (viewers decide to swipe by second 2).
8. No progress bar (a proven retention trick).

## What I'll add (all zero-cost, all stable)

### 1. Word-by-word animated captions ("karaoke style")

The single biggest quality lift. Because we generate the TTS ourselves from a known script line per scene, we already know the exact words and the exact audio duration (from `ffprobe`). Split words evenly across the clip's duration and burn them in with ffmpeg `drawtext` — one active word big + yellow + slight pop-scale, previous/next words dim. No transcription service, no key, deterministic.

Rendered with a bold display font committed to the repo (`assets/fonts/Anton-Regular.ttf`, ~40KB, SIL Open Font License — free forever, no attribution needed in-video).

### 2. Cinematic scene transitions

Replace the raw `concat` between the 4 clips with ffmpeg `xfade` transitions (rotate through `fade`, `slideleft`, `circleopen`, `dissolve`) — 0.4s crossfades. This alone makes the video feel professionally edited.

### 3. Music bed under the narration

Commit 5 short royalty-free instrumental beds (~30s each, mono 96kbps ≈ 350KB each, total ~1.7MB) under `assets/music/` — tracks sourced from freepd.com / CC0 (no attribution, safe on YouTube, no Content ID risk). Runner picks one per video (seeded by videoId) and ducks it under the voiceover via ffmpeg `sidechaincompress` so narration is always crystal clear.

### 4. Hero hook card (first 1.2 seconds)

Overlay the plan's `hook` text full-bleed in the display font on scene 1 for 1.2s (animated slide-in from bottom via `drawtext` with `enable=between(t,0,1.2)` + y-position expression). This is what stops the swipe.

### 5. Bottom progress bar

Thin animated bar at the very bottom (drawn via ffmpeg `drawbox` with width as a function of `t/total`) — subconsciously tells viewers "almost done, keep watching". Used by every viral shorts editor.

### 6. Cleaner end card

Replace the giant yellow SUBSCRIBE box with a two-line composition:
- Small avatar/emoji on left ("👇")
- "Subscribe to @CraftWebStudio" in the display font
- Animated red pulsing subscribe button (drawbox alpha oscillating with `sin(2*PI*t)`)

Kept for the last 2.5s.

### 7. Sharper output

Bump ffmpeg output to `1080×1920`, `-preset medium`, `-crf 20`, `-b:a 160k`. YouTube Shorts serves this size directly — no more soft upscale.

### 8. Better character-image prompts

Small prompt refactor in `tick.tsx`: add "professional Pixar-quality character sheet, dramatic cinematic lighting, shallow depth of field, ultra-detailed, 8k render, subject perfectly centered in safe area for vertical video" and negative-style hints ("no text, no logo, no watermark, no border") — same Pollinations endpoint, same seed logic, just better prompts. Free.

### 9. Better SEO on upload

In `autopilot-runner.mjs` upload body: append the hook as the very first line of the description (YT search weights this heavily), add `@CraftWebStudio` mention, and inject 3 broad tags always ("shorts fyp", "viral shorts", "storytime shorts") alongside the plan-derived ones.

## Files to change

| File | Change |
|---|---|
| `assets/fonts/Anton-Regular.ttf` | new — display font (SIL OFL) |
| `assets/music/bed-1.mp3` ... `bed-5.mp3` | new — 5 royalty-free instrumental beds |
| `assets/music/README.md` | new — track sources + license note |
| `scripts/autopilot-runner.mjs` | rewrite render pipeline: 1080p, xfade transitions, karaoke captions, music bed with sidechain duck, hook card, progress bar, new end card, better description/tags |
| `src/routes/api/public/autopilot/tick.tsx` | upgrade image prompt template only (unchanged flow) |

No schema changes. No new secrets. No new npm packages. No new API dependencies.

## Verification (I will not stop until all green)

1. Run the GitHub workflow with `force_test=true` after deploy.
2. Download the rendered mp4 from the run's artifacts / YouTube.
3. Screenshot check: hook card visible frame 1, captions animate word by word in sync with narration, transitions crossfade, music audible under VO but ducks when narrator speaks, progress bar fills to the right, end card shows @CraftWebStudio.
4. Confirm YouTube description starts with hook line and tags include the 3 broad ones.
5. Confirm total run time on GitHub Actions still under the free-tier minutes budget.
6. Repeat one more forced run to confirm music picker rotates and captions still align on a different script.

## Long-term safety

- Fonts and music are committed to the repo → immortal, no CDN can break them.
- ffmpeg is preinstalled on GitHub's `ubuntu-latest` runners → Microsoft maintains it.
- Pollinations + Lovable AI TTS are already the only external calls and are already error-handled with retries.
- No paid provider added, no key to rotate, no quota to exhaust beyond what you already run.
