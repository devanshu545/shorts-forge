Plan to fix Long → Shorts performance and stuck-progress issues

1. Stop blocking on source backup
- Make source backup optional and off by default for Long → Shorts.
- Start splitting from the local file immediately.
- Do not upload the whole source video unless the user explicitly enables “Backup source”.
- This removes the slow/stuck “Backing up source in background” path from the normal workflow.

2. Replace “polish by full re-encode” with a fast quality ladder
- Default mode: “Instant HD” using stream-copy cuts. This preserves original video quality and finishes in seconds because it does not re-render pixels.
- New mode: “Fast Polish” for one selected clip at a time, capped by a 5-minute time budget.
- If polish cannot finish inside the budget, automatically keep the instant high-quality clip instead of freezing for an hour.
- Remove any claim that browser 4K re-encode can always finish in seconds; that is physically limited by the user’s device CPU/browser.

3. Rework Smart 4K so it does not stall the app
- Stop running 4K upscale automatically for every generated clip.
- Generate clips normally first, then show a separate “Upgrade this clip” button.
- Use a timeout, ETA, cancel/fallback state, and “HD ready / 4K processing / 4K failed” badges.
- If 4K cannot complete under the time budget, keep the HD clip available and clearly show why it fell back.

4. Speed up clip uploads
- Upload video and thumbnail in parallel.
- Upload clips as soon as each clip finishes instead of waiting for all clips to render.
- Use signed upload URLs for clip files too, so upload progress can show real bytes/MB/s for every clip.
- Add retry with backoff for temporary HTTP errors.
- Register the clip in the database only after the storage upload succeeds, so broken clips do not appear as ready.

5. Add “not stuck” progress details
- Add elapsed time, ETA, current phase, current clip, processed MB, upload speed, last progress time, and ffmpeg log tail.
- Detect no-progress for a fixed window and show “slow but alive” vs “stalled”.
- Add cancel/stop handling so the user is never trapped waiting.

6. Reduce AI credit usage
- Do not call AI during splitting.
- Generate AI title/description/tags only when the user clicks publish or explicitly clicks “Generate SEO”.
- Keep the current frame-based title generation, but call it once per clip and cache the result.

7. Test path before calling it fixed
- Test one short generation locally with Instant HD and verify it creates a playable MP4 quickly.
- Test upload progress and retry behavior with one generated clip.
- Test Fast Polish with the 5-minute budget and verify it either finishes or cleanly falls back without freezing.

Important expectation
- True 4K cinematic re-rendering in seconds inside a browser is not realistically guaranteed on every laptop without quality/time tradeoffs. The reliable sub-5-minute fix is: instant original-quality shorts first, optional bounded polish/4K upgrade second, with no frozen progress and no wasted AI calls.