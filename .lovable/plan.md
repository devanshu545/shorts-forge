## Goal

Turn the current silent 4-image slideshow into a real narrated story short: the script drives the voiceover, each scene's keyframe shows the character's emotion at that beat, a small SUBSCRIBE watermark sits on every frame, and a bigger "Sub for part 2" reveal plays at the end. Timing of each scene follows the length of its voiceover so the picture always matches the words.

## What changes

### 1. Script now includes narration + emotion per scene
Extend the Lovable AI plan (`character-short.functions.ts` → `CharacterPlan`) so every scene beat carries two new fields:
- `voiceover` — 1–2 spoken sentences (≤ ~18 words) describing what's happening.
- `emotion` — one of: `happy`, `curious`, `surprised`, `sad`, `determined`, `proud`, `sleepy`, `excited`, `scared`, `hopeful`.

The 4 voiceovers together form the full story. Prompt is tightened so scene 4 lands the emotional payoff and naturally leads into a "part 2" hook.

### 2. Keyframes reflect the emotion
`generateSceneKeyframe` prompt is expanded to inject the emotion into the Pollinations request, e.g.
`"…tiny orange fox kit with a wide **surprised** expression, ears perked up, mouth slightly open…"`.
This makes each of the 4 free Flux renders visibly different in expression, not just background.

### 3. Free voiceover via Lovable AI TTS
Add a new server function `generateSceneVoiceover` that calls Lovable AI Gateway's `openai/gpt-4o-mini-tts` (already provisioned, no billing) and uploads each MP3 to the `audio` bucket. One MP3 per scene, so timing is per-scene, not one long file.

Voice defaults to `alloy` (warm, neutral). A small voice picker (`alloy`, `nova`, `shimmer`, `echo`, `onyx`) is added to the Generate form.

### 4. Stitcher becomes audio-aware
`stitcher.ts` upgrades:
- Accepts `{ imageUrl, audioUrl }` per scene.
- Each scene's on-screen duration = that scene's audio duration (min 3s, max 8s).
- Builds a combined `AudioContext` → `MediaStreamAudioDestinationNode`, mixes the four MP3s in sequence, and merges that track into the canvas stream so `MediaRecorder` writes video **and** audio into the WebM.
- Ken-Burns motion timing rescales to each scene's real duration.
- **Small persistent SUBSCRIBE watermark**: bottom-right, ~5% width, semi-transparent yellow pill, present from frame 0 to end.
- **End card**: last ~2s the small watermark grows into the big yellow "SUBSCRIBE" ribbon and the top text "Sub for part 2 👇" pops in.

### 5. Generate page copy + progress
- New stage labels: `"Writing story…"`, `"Recording narration for scene N…"`, `"Painting scene N (feeling: happy)…"`, `"Stitching narrated video…"`.
- Voice picker under the tone chips.
- Result card gets a chip showing total duration and that audio is embedded.

## Files touched

```text
src/lib/animation/character-short.functions.ts   scene schema: +voiceover +emotion; new generateSceneVoiceover fn
src/lib/animation/stitcher.ts                    audio mixing, per-scene duration, persistent watermark, end-card
src/routes/_authenticated/generate.tsx           voice picker, call voiceover per scene, pass audio urls to stitcher
src/components/SceneProgress.tsx                 show emotion label + tiny audio icon when a scene has narration
```

No new secrets, no new packages. Still 100% inside your existing free stack:
- Lovable AI (script + TTS) — already provisioned.
- Pollinations (keyframes) — free public endpoint.
- Browser canvas + WebAudio (mix + record) — free forever.

## Technical notes

- Lovable AI TTS: `POST https://ai.gateway.lovable.dev/v1/audio/speech`, `model: "openai/gpt-4o-mini-tts"`, `stream_format` omitted (we want a single MP3 blob to upload), `response_format: "mp3"`. Uploaded to `audio/{userId}/{videoId}/scene-{n}.mp3`, signed URL returned.
- MediaRecorder in Chromium supports `video/webm;codecs=vp9,opus`; we already pick opus-capable mime. To include audio we build the stream from `[...canvas.captureStream().getVideoTracks(), destinationNode.stream.getAudioTracks()[0]]`.
- Audio scheduling uses `AudioBufferSourceNode.start(when)` chained per scene start time so playback stays in lockstep with the visual switch.
- If TTS ever 402s (out of Lovable credits), the pipeline falls back gracefully: video renders without audio, warning toast tells the user credits ran out. Never blocks the render.

## Result

One click → Lovable AI writes a 4-beat story with per-scene narration + emotion → Pollinations paints each scene with the matching expression → Lovable AI narrates it → your browser mixes narration + Ken-Burns visuals + persistent SUBSCRIBE watermark + end-card into a single narrated WebM in your Library. Ready to upload to YouTube.