## Goal
Upgrade Split → Shorts so clips feel premium (not "just a cut"), unblock 4K, and give each short an AI-crafted ≤40-char title based on real content.

## 1. Kill the 4K stall — "Smart Upscale"
Current flow tries real 4K in ffmpeg.wasm → 30+ min stalls.

New flow when user picks 4K:
- **Phase A (instant, ~30–60s)**: stream-copy the cut like Instant Mode → short is ready in library, playable immediately, tagged `quality: 1080p-source, upscale: pending`.
- **Phase B (background, ~3–6 min)**: kick a re-encode job that:
  - Runs a `lanczos` upscale + light sharpen + film-grain in ffmpeg.wasm at 2160×3840, `preset=ultrafast`, `crf=23`, 12 Mbps cap (small enough to finish).
  - Streams progress into the same clip card (badge: "Upscaling to 4K… 42%").
  - On finish, swaps the storage file, flips badge to "4K Ready".
  - On failure, keeps 1080p and shows "4K unavailable — kept HD" instead of the current hard error.
- Add a manual "Retry 4K" button per clip.
- Concurrency = 1 upscale at a time (queue), so the tab doesn't freeze.

## 2. Make shorts stop looking cheap — auto-polish pass
Every generated clip runs through a polish step before it's saved:

- **Background music**: pick one royalty-free track per genre (upbeat / emotional / suspense / chill) from `assets/music/`. Duck it to −18 dB under the original audio using ffmpeg `sidechaincompress`. If no music files present yet, generate 4 loops via ElevenLabs Music API once and cache under `assets/music/`.
- **Hook text (first 2s)**: AI-generated 3–5 word hook drawn as bold white text with black stroke, animated pop-in (scale 0.8→1). Rendered via ffmpeg `drawtext` with a bundled Inter-Black TTF.
- **Zoom/pan motion**: subtle Ken Burns (`zoompan`, 1.0→1.08 over clip length) so static-feeling shots breathe.
- **Intro/outro branding**: 0.4s black-flash intro + 0.6s outro card ("More on @channel") built as a ffmpeg overlay.
- All polish runs in the same ffmpeg pass as the cut → one encode, not three.

## 3. AI-generated titles based on actual content (≤40 chars)
Right now SEO only sees filename + timestamps. Fix:

- **Frame sampling**: after cut, use browser `<video>`+`<canvas>` to grab 4 frames (10 %, 35 %, 60 %, 85 %). Encode as small JPEGs (≤200 KB each).
- **Audio transcript**: extract clip audio to 16 kHz mono WAV via ffmpeg, send to `openai/gpt-4o-mini-transcribe` through Lovable AI Gateway.
- **Title generation**: send frames (as `image_url` blocks) + transcript + segment timing to `google/gemini-2.5-flash` with a prompt that enforces:
  - ≤ 40 characters (validated + hard-truncated in code)
  - 1 emoji max
  - No clickbait quotes
  - Hook-first phrasing
- Description + tags reuse the same context so they match the title.
- Fallback: if transcript empty (silent clip) → frames-only; if vision fails → filename hint. Never block publish.

## 4. UI updates in `/split`
- Resolution picker: "Instant HD" (default) · "4K Smart Upscale" (with "~5 min in background" hint).
- Per-clip card shows: quality badge, upscale progress bar, "Retry 4K" button, live AI-generated title (editable inline before publish).
- Music genre selector (auto / upbeat / emotional / suspense / chill).
- Toggle: "Add hook + branding" (on by default).

## 5. Files touched
- `src/lib/ffmpeg-splitter.client.ts` — polish pass, smart-upscale phase A/B queue, frame sampler, audio extractor.
- `src/lib/seo.functions.ts` — accept `frames[]` + `transcript`, enforce ≤40 chars.
- New `src/lib/transcribe.functions.ts` — server fn wrapping `gpt-4o-mini-transcribe`.
- New `src/lib/music-library.ts` + one-time ElevenLabs music seeding script → files under `assets/music/`.
- `src/routes/_authenticated/split.tsx` — new UI, upscale progress, editable title.
- `src/components/OneClickPublishButton.tsx` — pass frames + transcript hint through.
- Bundle Inter-Black TTF under `public/fonts/` for `drawtext`.

## Technical notes
- All heavy work stays in the browser tab (no server credit burn for encode/upscale).
- Only AI calls (transcribe + title + one-time music seed) touch Lovable credits — ~$0.002 per short.
- Upscale uses `-vf scale=2160:3840:flags=lanczos,unsharp=5:5:0.8` — visually crisp without slow AI models.
- All ffmpeg filters chained in a single `-filter_complex` graph so we don't multiply encode time.
- Hook text + music + branding fully skippable if user toggles off.

## What you get
- Click "Create Instant Shorts" → clips appear in ~1 min with music, hook text, motion, branding, and a real AI title like "😳 He didn't see this coming".
- 4K toggle → same clips appear instantly at HD, upgrade to true 4K in the background without freezing the tab.
- Titles ≤ 40 chars, grounded in what's actually on screen and being said.