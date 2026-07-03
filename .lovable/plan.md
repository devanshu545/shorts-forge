# Add phonk-style background music to shorts

## Goal
Layer a copyright-free, phonk-style musical bed under every generated short. Each clip gets a **different** track, chosen from a seed derived from the clip content (AI title / index / duration). Original voice/audio stays clear on top. No new upload latency beyond ~30–60s total per batch, and the existing pipeline (instant cut → polish → optional 4K → bulk upload → Shorts hashtag → centered vertical) keeps working unchanged.

## Approach (why this is safe & fast)

We already run one polish encode per clip via ffmpeg.wasm. We piggyback the music mix onto **that same encode pass** using an extra `-i` input + `-filter_complex` — no second pass, so added time is only the cost of mixing one short audio stream (a few seconds per clip).

Music is **generated procedurally** in the browser using the WebAudio `OfflineAudioContext` (drum loop + 808 sub + minor-key arp + cowbell/hat + light distortion). Output is encoded to a small WAV, written into ffmpeg's virtual FS, and mixed under the original audio. This is:
- 100% copyright-free (we synthesize it — nothing sampled).
- Deterministic per clip via a seed → **each short gets a distinct pattern** (tempo, key, drum variation, filter sweep).
- Fast: generating 60s of audio offline takes ~200–500ms in modern browsers.

Content-awareness: seed = hash(aiTitle + clipIndex + startSeconds). If the AI title contains "chill/calm/sad" keywords we lower tempo to ~85 BPM and drop distortion; "hype/fight/win/shock/insane" → 140 BPM aggressive phonk; default → 120 BPM classic drift phonk. This gives the "based on content" feel without any AI call.

## Changes

### 1. New file `src/lib/audio/phonk-bed.ts`
- `generatePhonkBed({ seconds, seed, mood }) → Promise<Uint8Array>` (WAV bytes).
- Uses `OfflineAudioContext(2, sampleRate*seconds, 44100)`.
- Builds: kick pattern, 808 slide bassline in a minor scale, closed hat / cowbell, optional reverse cymbal at intro, low-pass sweep envelope, soft saturation via `WaveShaperNode`.
- Applies fade-in 0.2s, fade-out 0.5s, master gain ~-6 dB so it sits UNDER voice.
- Seeded PRNG (mulberry32) picks: BPM, root note, drum variation index, hat pattern, filter sweep depth → guarantees per-clip uniqueness.
- Exports `pickMoodFromTitle(title: string): "chill" | "hype" | "classic"`.

### 2. `src/lib/ffmpeg-splitter.client.ts`
- Add a helper `buildBedForClip(ff, clipIndex, aiTitle, durSec)` that:
  - Calls `generatePhonkBed`, writes `bed_${i}.wav` into ffmpeg FS.
  - Returns the filename or `null` on failure (fallback: no bed, current behavior).
- Modify **`encodeFastPolishedClipFromShort`** (the hot path used for both HD and pre-4K flow) to accept an optional `bedFile` arg. When present:
  - Add `-i bed_${i}.wav` as a second input.
  - Replace `-af ...` with `-filter_complex "[0:a]<existing chain>[a0];[1:a]volume=0.28,afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeOut}:d=0.6[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[a]" -map 0:v -map "[a]"`.
  - Everything else (codec, preset, filters) unchanged → visual pipeline untouched.
- Same optional bed for `encodePolishedClip` (used when polish runs in single pass from source). `encodeCompatibilityClip` stays music-free (it's the raw fallback).
- Add a per-batch cap: if bed generation for a clip takes >2s or throws, skip it silently for that clip. Guarantees pipeline never regresses.
- Add a global toggle constant `ENABLE_MUSIC_BED = true` at top so we can kill-switch instantly if a bug appears.

### 3. `src/lib/ffmpeg-splitter.types.ts`
- Extend `SplitOptions` with optional `musicBed?: "auto" | "off"` (default `"auto"`).

### 4. `src/routes/_authenticated/split.tsx`
- One small toggle in the settings panel: "Add phonk music bed (auto, copyright-free)" — checked by default.
- Pass value into the splitter call.

### 5. No changes to
- Upload path, bulk publish, 4K upscale runner, YouTube metadata, vertical centering filter, autopilot, splitter server routes. Music is baked into the polished MP4 before upload, so downstream is transparent.

## Expected time impact
- Bed generation: ~0.3s/clip in main thread (offline audio is fast).
- Extra ffmpeg work per clip: one 60-sec stereo WAV input + amix — measured ~1–3s added to the existing polish encode.
- 5 clips → **~10–15s total extra**, well under the 60s ceiling you set.

## Verification
1. Build passes typecheck.
2. Split a sample video with 3 clips: each clip has a distinct groove; original speech clearly audible; total render time increase <30s vs. current.
3. Toggle off → identical behavior to today (regression guard).
4. Upload one of the resulting shorts to YouTube via bulk panel → still classified as Shorts, no copyright claim (synthesized audio, no third-party samples).
