# Autopilot: Custom Times + Feature Menu

## Part 1 — Custom schedule times (dynamic)

Today the schedule is hardcoded to 3 hour-slots picked from a fixed dropdown. Rework it so you can add/remove any number of times and each time is picked freely.

### UI changes (`/autopilot` settings card)

- Replace "Videos per day" slider + fixed hour selects with a **dynamic time list**:
  - `+ Add time` button appends a new row.
  - Each row: a native `<input type="time">` (HH:MM) + a delete button.
  - Reorder-safe (sorted on save), min 1 / max 8 rows.
- Timezone select stays as-is (defaults to browser tz).
- "Videos per day" becomes a read-only derived count from the list length.
- Save button pushes the full list; UI reflects it immediately (optimistic update) and re-queries health so upcoming slots refresh.

### Backend / data changes

- `autopilot_settings.slot_hours` (int[]) → add new column `slot_times text[]` storing `"HH:MM"` strings. Keep `slot_hours` for backward compat, auto-derived from `slot_times` on save.
- `saveAutopilotSettings` Zod schema accepts `slot_times: string[]` (regex `^([01]\d|2[0-3]):[0-5]\d$`), 1–8 entries; derives `slot_hours` = unique hours.
- `computeUpcomingSlots` (health) uses `slot_times` for minute precision.
- Tick endpoint `isSlotDue`: matches current local `HH:MM` against `slot_times` within a ±5 min window (since cron runs hourly, see caveat below).

### ⚠️ Important scheduling caveat (must decide)

GitHub Actions cron currently runs **once per hour** (`0 * * * *`). That means:

- **Option A (recommended, no cost):** keep hourly cron. Minute values are honored to the nearest hour — a time of `09:35` fires in the `09:00` run. Simple, free, reliable.
- **Option B (true minute precision):** change cron to `*/5 * * * *` (every 5 min). Uses ~12× more GitHub Actions minutes but still well within the free tier for a personal repo. Fires within 5 min of chosen time.
- **Option C:** every 15 min (`*/15 * * * *`). Middle ground.

I'll implement **Option B** by default unless you say otherwise — it makes the "choose any time" feature actually feel dynamic.

---

## Part 2 — Feature menu (pick what to build next)

Below are features that are **realistic to build** on the current free stack (GitHub Actions + Lovable Cloud + Lovable AI + Pollinations + YouTube API). Each notes cost/risk so you can pick safely.

### Scheduling & automation

1. **Custom per-slot settings** — different character / genre / voice per time slot (e.g. funny at 9am, emotional at 8pm).
2. **Pause days** — checkbox for days of week the autopilot skips (e.g. no Sundays).
3. **Auto-pause on failure streak** — if 3 uploads fail in a row, disable autopilot and notify.
4. **"Catch up" mode** — if a slot was missed (YouTube outage, quota), auto-retry within the next hour.
5. **Manual queue** — write a topic in a text box; it becomes the next scheduled upload, jumping the trending picker.

### Content quality

6. **Series mode** — every N videos forms a "Part 1/2/3" chain with the same character storyline.
7. **Multi-character mode** — pick 2–3 characters; each short randomly stars one for variety.
8. **Style presets** — swap image prompt style (Pixar / anime / claymation / paper cutout) per short or per slot.
9. **Trending topic sources** — add Reddit r/AskReddit + Google Trends RSS on top of current source for richer topics.
10. **Voice variety** — rotate through multiple TTS voices per short instead of one fixed voice.
11. **Background music library** — pick a mood (chill / epic / funny) per genre instead of the synthesized bed.

### Analytics & feedback loop

12. **Per-video performance card** — pull YouTube Analytics API views/likes/CTR per autopilot short, show in Library.
13. **Best-time recommender** — after 30 uploads, suggest your 3 best-performing slot times.
14. **A/B title testing** — generate 2 titles, upload with title A, auto-swap to title B after 6h if views are low.
15. **Auto-delete flops** — after 7 days, hide/unlist shorts with <50 views (optional toggle).

### UX in the app

16. **Live "next upload" countdown** on the Autopilot page.
17. **Preview a slot** — click a slot to instantly render a preview of what *would* be uploaded at that time (no upload).
18. **Notification center** — in-app bell with autopilot events (uploaded, skipped, failed).
19. **Export schedule as .ics** — subscribe to your upload calendar from Google Calendar.

### Reach / SEO

20. **Auto-generated end-screen CTA** rotating between "Subscribe", "Watch part 2", "Comment your guess".
21. **Comment seeding** — auto-post the first comment (a question) on each upload to prime engagement.
22. **Hashtag rotator** — pool of 50 viral hashtags, pick 3 per upload to avoid YouTube spam-flagging.
23. **Community post** — after each Short, auto-post a poll to the YouTube Community tab teasing the next one.

### ❌ Not recommending (won't work reliably free)

- Real Veo/Sora video generation (paid + quota).
- Cross-post to TikTok/Instagram (their APIs require business review, unreliable free).
- Real-time trending scraping from TikTok (blocked, breaks weekly).

---

## What I need from you

1. **Confirm Part 1** — build the custom-time UI + switch cron to every 5 min (Option B)? Or stick with hourly?
2. **Pick features from Part 2** — list the numbers you want. I'll build them in the next plan(s), grouped for minimal credit use.   
  do all in this one 
    
  Redesign ONLY the UI/UX of the entire application. Do NOT modify, remove, or refactor any existing backend logic, APIs, database schema, authentication, routing, state management, AI pipeline, rendering pipeline, business logic, event handlers, or any working functionality. The application is currently functional, and I want a visual overhaul only. Replace the current blue theme with a premium Apple-inspired Liquid Glass / Glassmorphism design featuring frosted glass panels, translucent backgrounds, backdrop blur, subtle gradients, soft borders, realistic reflections, elegant shadows, rounded corners, and depth. Add smooth, GPU-accelerated animations throughout the interface, including page transitions, hover effects, button interactions, cards, dialogs, sidebars, loading states, progress indicators, modals, dropdowns, inputs, navigation, and micro-interactions. Support both dark and light themes with beautiful dynamic glass effects and modern typography. Make the UI feel like a premium macOS/iOS application with polished motion and fluid animations while maintaining excellent performance and responsiveness. Do NOT break any existing functionality, change API calls, alter component behavior, rename IDs/classes relied upon by the application, or introduce regressions. The only goal is to transform the visual design into a premium animated glassmorphism interface while preserving 100% of the existing functionality.  
