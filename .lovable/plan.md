## Goal

Remove GitHub from the long-video splitter only (Autopilot keeps using GitHub). Move splitting to browser-side ffmpeg.wasm. Boost clip quality (1080p max-bitrate + optional true 4K), auto-fill SEO metadata and publish public on upload, and add detailed progress + more UI animations — without touching the Autopilot pipeline.

## 1. Splitter → browser-side ffmpeg.wasm

- Install `@ffmpeg/ffmpeg` + `@ffmpeg/util`; serve core WASM from `public/wasm/ffmpeg/` (no CDN).
- Rewrite `/split`: after MP4 upload to Supabase Storage, ffmpeg.wasm runs entirely in-browser — scene detection (`select='gt(scene,0.35)'`), then per-clip encode to 1080x1920 (or 2160x3840 if 4K toggled) with `-crf 18 -b:v 12M -preset veryfast -pix_fmt yuv420p -movflags +faststart`, plus unsharp mask.
- Each finished clip + thumbnail is POSTed to the existing `/api/public/splitter/complete` endpoint. `/finish` at the end.
- Delete `.github/workflows/splitter.yml` and `scripts/splitter-runner.mjs`. Keep the three `/api/public/splitter/*` routes — the browser is the "worker" now.
- Add a 4K toggle in the UI (default off, warns: slow + big files, no visible Shorts gain).

## 2. Autopilot clip quality (unchanged worker)

- Bump `renderer.ts` canvas + MediaRecorder to 1080x1920 @ 12 Mbps with sharper Ken Burns. Keep GitHub Actions.

## 3. Auto-upload defaults

- `UploadToYouTubeDialog` and splitter clip cards get a "One-click publish" button that:
  - Auto-generates SEO title (≤60ch), description w/ hashtags, 15 tags via Gemini from clip source metadata / filename.
  - Sets `privacyStatus: "public"`, `selfDeclaredMadeForKids: false`, `categoryId: "24"`.
  - Uses existing `uploadExistingVideoToYouTube` server fn.
- Same one-click available on manual "Test Flow" videos.

## 4. Detailed progress

- Per-clip card: stage (`Probing → Detecting scenes → Encoding clip N/M → Uploading → Done`), %, ETA (rolling avg), ffmpeg fps, upload MB/s.
- Autopilot health card: compact live progress strip when a run is active.

## 5. UI polish (presentational only)

- framer-motion enter/exit on cards, staggered list reveals, hover glow on primary buttons, animated gradient border on active job cards, shimmer on progress fills. Keep glass tokens.

## Files

Edit: `src/routes/_authenticated/split.tsx`, `src/lib/splitter.functions.ts`, `src/components/UploadToYouTubeDialog.tsx`, `src/lib/animation/renderer.ts`, `src/routes/_authenticated/autopilot.tsx`, `src/routes/_authenticated/library.tsx`, `src/styles.css`.
New: `src/lib/ffmpeg-splitter.client.ts`, `src/components/ClipProgress.tsx`, `src/lib/seo.functions.ts`.
Delete: `.github/workflows/splitter.yml`, `scripts/splitter-runner.mjs`.
Install: `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `framer-motion` (if missing).

## Out of scope

Autopilot worker (still GitHub), payments, DB schema changes.
