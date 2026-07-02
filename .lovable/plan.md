## Goal

Stop requiring the paid Google/Vercel video API keys. Generate free, silent, caption-less animated character shorts using **Remotion** (code-rendered MP4s) so you can produce YouTube-ready content with zero video-API cost. Videos will feature simple animated characters acting out a logical scene — engaging enough to post.

## What changes

### 1. New free video backend: Remotion-based renderer

- Add a new server path `renderAnimatedShort` in `src/lib/media.functions.ts` that becomes the DEFAULT backend when no `GEMINI_API_KEY` / `AI_GATEWAY_API_KEY` is present.
- No paid API calls for the actual video pixels. Uses Lovable AI (already free via `LOVABLE_API_KEY`) only for the *scene plan* (JSON describing characters, actions, background, beats).
- Pipeline:
  1. Take the existing generated script (scenes + durations).
  2. Ask Gemini (free tier via Lovable AI) to convert each scene into a structured **animation plan**: character (name, color, emoji face, position), action (walk, jump, hug, wave, spin, chase), background scene (park, kitchen, street, sky), props.
  3. Render the plan headlessly with Remotion inside the server function to produce a 9:16 1080x1920 MP4.
  4. Upload the MP4 to the existing `videos` Supabase Storage bucket, return signed URL, update the `videos` row exactly like today.

### 2. Animated character system (silent, caption-less)

Since you want **no sound and no captions**, characters must be visually expressive on their own. Built-in library of reusable SVG/CSS characters:

- Simple stylized humanoids (round head + body, animated arms/legs) with 6 base color variants.
- Facial expressions (happy, shocked, angry, thinking, laughing, crying) swapped per beat.
- Basic action rigs driven by `useCurrentFrame() + spring()`: walk-cycle, jump, wave, throw, fall, chase, hug, high-five, spin.
- Background scenes as layered gradients + parametric shapes (park with sun/clouds/grass, kitchen, city street, night sky, boxing ring, classroom).
- Props: ball, phone, coffee, money bag, heart, question mark, lightning bolt.

Each scene reads: `{ characters: [...], action: "chase", background: "park", props: ["ball"], duration: 4 }` and Remotion picks the right rig.

### 3. Backend selection logic

Update `getVideoBackend()` in `src/lib/media.functions.ts`:

- Default: `"remotion-animated"` (free, always available).
- If user explicitly sets `GEMINI_API_KEY`: allow choosing Veo 3.1.
- No more "video generation blocked" errors when keys are missing — the free path always works.

### 4. UI (`src/routes/_authenticated/generate.tsx`)

- Add a small selector: **Style** → `Animated characters (free)` (default) / `Realistic video (Veo, needs key)`.
- Progress messages updated: "Planning scenes…", "Rendering frame 120/900…", "Uploading…".
- Keep everything else the same; user still clicks **Generate video** and gets an MP4 in library.

### 5. Sandbox rendering setup

- Add `remotion`, `@remotion/cli`, `@remotion/renderer`, `@remotion/bundler`, `@remotion/compositor-linux-x64-musl` to `package.json`.
- Server function invokes Remotion programmatically (bundle + renderMedia) writing to a temp file, then streams into Supabase storage.
- Muted output (`muted: true`) to avoid the ffmpeg AAC issue and match your "soundless" requirement.

### 6. Safety / credit protection

- Only 1 Lovable AI call per video (scene-plan JSON) — cheap.
- Zero external video-API calls in the default path.
- Preserve existing script + metadata on any render failure so nothing is regenerated.
- Clear inline error if Remotion render fails (with the actual stderr line).

## Out of scope

- No voiceover, no TTS, no captions/subtitles (per your request).
- Not touching YouTube OAuth or scheduler this turn.

## Files to edit

- `src/lib/media.functions.ts` — new `renderAnimatedShort` path, updated `getVideoBackend`.
- `src/lib/animation/` (new) — `plan.ts` (Gemini → plan schema), `characters.tsx`, `scenes.tsx`, `actions.tsx`, `RemotionRoot.tsx`, `AnimatedShort.tsx`.
- `src/lib/animation/render.server.ts` — programmatic Remotion render helper.
- `src/routes/_authenticated/generate.tsx` — style selector + updated progress copy.
- `package.json` — Remotion deps.

## Confirm before I build

1. OK to make **Animated characters (free)** the default and keep Veo as an opt-in when a key is added later?
2. Target duration caplock animated shorts to 15–30s for faster renders