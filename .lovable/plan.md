## Goal

Reproduce the reference's look (hyper-realistic 3D Pixar-style animal short, 9:16, ~18s, single recurring character across 4 scenes, "Comment for part 3" + SUBSCRIBE overlay at the end) from any topic + character the user picks.

## Reality check on the "videogen tool via server pipeline"

The Lovable `videogen` tool is an **agent-only tool** — it runs in my sandbox, not in your app's server code. Your app cannot invoke it at runtime. So a real "server-triggered pipeline" needs a video-generation HTTP API. Two viable providers, in order of preference:

1. **Lovable AI Gateway video model** (uses your existing `LOVABLE_API_KEY`, no new secret). I will verify at implementation start whether the gateway exposes a Kling/Seedance/Veo endpoint. If yes → use it. This is why our earlier Veo attempt 404'd; we hit the wrong path.
2. **fal.ai** (fallback): fastest and cheapest realistic video API for this use case — Kling 2.1 image-to-video ≈ $0.05–0.15 per 5s clip. Requires you to add a `FAL_KEY` secret (I'll walk you through where to get it if #1 doesn't pan out).

I'll not touch billing without asking. If #1 works we ship on that; if not I stop and ask before adding fal.

## Locked video template

Every generated video follows this exact shape (~18s, 30 fps, 1080×1920):

| Beat | Duration | Purpose |
|---|---|---|
| Scene 1 — Character intro / hook | 4s | Show character in idyllic setting |
| Scene 2 — Activity begins | 5s | Character starts the topic action |
| Scene 3 — Activity mid / twist | 5s | Payoff moment |
| Scene 4 — Reveal / "look at camera" | 4s | Character faces camera, emotional close |
| CTA overlay | last 3s of Scene 4 | "Comment for part 3" top, animated SUBSCRIBE yellow ribbon bottom |

Character consistency: I generate one **reference keyframe** with imagegen (Lovable AI, free) using the user's character description. Every scene's video prompt reuses the same character-description phrase verbatim + the scene's setting/action. For providers that support image-to-video, scene 1's last frame seeds scene 2, etc.

## UI changes (`/generate`)

Replace current style selector with:

- Character picker (visual cards): Ginger Cat, Golden Retriever Puppy, Panda Cub, Bunny, Fox Kit, Baby Elephant, Duckling, "Custom…"
- Topic input (existing, relabeled: *"What is your character doing?"* — e.g. "learning to bake a cake", "fishing at a lake", "opening a lemonade stand")
- Tone chips: Wholesome / Funny / Adventurous / Cozy
- One button: **Generate short** (no more Veo/Animated toggle)
- Progress panel showing 4 scene thumbnails as they render (image → video swap)

## Pipeline (server functions + client stitcher)

1. `planCharacterShort` (`src/lib/animation/character-plan.functions.ts`, Lovable AI Gemini) → returns `{ character: {name, species, appearance, wardrobe}, scenes: [{setting, action, mood, cameraShot}] × 4, cta: {top, bottom} }`. Strict short prompts to avoid Gemini state-limit errors.
2. `generateSceneKeyframe` (imagegen, per scene) → 1080×1920 PNG stored in `videos` bucket at `{uid}/{videoId}/keyframes/{n}.png`.
3. `generateSceneClip` — server function that calls the chosen video provider with `{ prompt, image_url: keyframe_url, duration }` and polls the long-running operation. Returns an mp4 URL saved at `{uid}/{videoId}/clips/{n}.mp4`.
4. Client stitcher (`src/lib/animation/stitcher.ts`): loads the 4 clips into hidden `<video>` elements, plays them sequentially onto a 1080×1920 canvas at 30 fps, overlays the CTA text (Titan One yellow ribbon animated with `interpolate`-style easing) during the last 3s, records via `MediaRecorder` → single WebM, uploads as the final `videos/{uid}/{videoId}.webm`, marks row `ready`.
5. Metadata + thumbnail (existing `generateMetadataForVideo` + `maybeGenerateThumbnail`) run after.

Credit-waste guards: if any scene clip fails, retry once, then abort the run and mark the row `failed` with the provider error surfaced. Never proceed to the next paid step after a failure.

## Files to touch

- `src/routes/_authenticated/generate.tsx` — replace style selector with character picker; wire new pipeline
- `src/components/CharacterPicker.tsx` — new
- `src/components/SceneProgress.tsx` — new (4-tile progress)
- `src/lib/animation/character-plan.functions.ts` — new (replaces plan.functions.ts for this flow)
- `src/lib/animation/scene-clips.functions.ts` — new (keyframe + clip generation, provider abstraction)
- `src/lib/animation/stitcher.ts` — new (client-side canvas + MediaRecorder final assembly with CTA overlay)
- `src/lib/animation/renderer.ts` — keep, no longer default
- `src/lib/media.functions.ts` — remove Veo direct-call path (unused), keep metadata/thumbnail helpers

DB: no schema change. Reuse `videos` row; add scene URLs to the existing `script` JSONB field.

## Verification (before saying done)

1. Run one end-to-end generation with the ginger cat + topic "fishing at a pond then cooking the catch" and confirm the resulting mp4 in Library visually matches the reference (character consistent across scenes, CTA overlay present, ~18s, 9:16).
2. Confirm failure path: kill provider mid-run, check the row goes to `failed` with a clear message and no further billable calls fire.
3. Confirm Library playback + YouTube upload dialog still works with the new file.

## Open decision I'll ask about only if needed

If the Lovable AI Gateway does not expose a video-generation endpoint, I'll stop and ask you to add a `FAL_KEY` before spending credits. I will not silently swap in a new billable provider.
