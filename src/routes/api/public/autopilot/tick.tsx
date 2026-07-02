import { createFileRoute } from "@tanstack/react-router";
import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { pickTrendingTopic } from "@/lib/trending.server";
import { CHARACTERS, EMOTIONS, CharacterPlanSchema, type CharacterPlan } from "@/lib/animation/character-short.functions";

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("Model did not return JSON");
  const raw = candidate.slice(first, last + 1);
  try { return JSON.parse(raw); } catch { return JSON.parse(jsonrepair(raw)); }
}

const EMOTION_HINTS: Record<string, string> = {
  happy: "wide joyful smile, sparkling eyes",
  curious: "head tilted, wide inquisitive eyes",
  surprised: "eyes huge, mouth in a round O",
  sad: "droopy eyes, small frown, ears folded",
  determined: "focused eyes, tight mouth, confident pose",
  proud: "chest puffed, chin up, satisfied smile",
  sleepy: "half-closed eyes, tiny yawn",
  excited: "huge grin, jumping pose",
  scared: "trembling, eyes huge",
  hopeful: "gentle smile, looking up",
};

async function planStory(userTone: string, character: string, storyPrompt: string): Promise<CharacterPlan> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY not configured");
  const provider = createLovableAiGatewayProvider(key);
  const model = provider("google/gemini-2.5-flash");
  const system = `You script viral narrated YouTube Shorts about a single recurring 3D-animated character.
Return ONLY a JSON object matching:
{"title": string, "hook": string, "description": string, "hashtags": string[], "scenes": [ 4 items with { "order", "setting", "action", "cameraShot", "mood", "emotion", "voiceover" } ], "cta": {"top": "Sub for part 2 👇", "bottom": "SUBSCRIBE"}}

STRICT WRITING RULES for voiceover text:
- Use VERY SIMPLE English. Grade-3 reading level. Short words. No jargon.
- Each voiceover is 1-2 short spoken sentences, MAX 18 words total.
- Third person warm narrator ONLY. No stage directions, no quotes, no sfx.
- Every scene MUST logically follow from the previous one (setup -> problem -> turn -> payoff).
- Scene 4 pays off the story AND opens a curious cliffhanger for "part 2".
- emotion: ONE string from ${EMOTIONS.join("|")}.`;
  const user = `Character: ${character}\nStory idea: ${storyPrompt}\nTone: ${userTone}\nWrite the 4 scenes now. Return ONLY JSON.`;
  const { text } = await generateText({ model, system, prompt: user });
  return CharacterPlanSchema.parse(extractJson(text));
}

async function fetchPollinationsBase64(prompt: string, seed: number): Promise<string> {
  const encoded = encodeURIComponent(prompt.slice(0, 900));
  const variants = [
    `width=720&height=1280&nologo=true&enhance=true&model=flux&seed=${seed}`,
    `width=720&height=1280&nologo=true&model=flux&seed=${seed + 7}`,
    `width=512&height=896&nologo=true&enhance=true&model=flux&seed=${seed + 17}`,
  ];
  for (let attempt = 0; attempt < 6; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const url = `https://image.pollinations.ai/prompt/${encoded}?${variants[attempt % variants.length]}`;
      const res = await fetch(url, { headers: { Accept: "image/*" }, signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > 2000) return Buffer.from(buf).toString("base64");
      }
    } catch {
      clearTimeout(timeout);
    }
    await new Promise((r) => setTimeout(r, 2500 + attempt * 1500));
  }
  throw new Error("Pollinations image failed");
}

async function generateTtsBase64(text: string, voice: string): Promise<string> {
  const key = process.env.LOVABLE_API_KEY!;
  const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini-tts",
      input: text,
      voice,
      response_format: "mp3",
      instructions: "Narrate warmly and clearly like a kind children's storybook narrator. Speak simply, natural pacing.",
    }),
  });
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

function currentSlotKey(slotISO: string) {
  return slotISO;
}

// Returns the matched slot time "HH:MM" if the current local time (in tz) is
// within ±5 minutes of any slot_time entry; else null.
function isSlotDue(slotTimes: string[], pauseDays: number[], timezone: string): string | null {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
    }).formatToParts(now);
    const wdMap: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
    const wd = parts.find((p) => p.type === "weekday")?.value;
    if (wd && pauseDays.includes(wdMap[wd])) return null;
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "-1");
    if (hh < 0 || mm < 0) return null;
    const nowMin = hh * 60 + mm;
    for (const t of slotTimes) {
      const [sh, sm] = t.split(":").map(Number);
      const slotMin = sh * 60 + sm;
      if (Math.abs(nowMin - slotMin) <= 5) return `${String(sh).padStart(2,"0")}:${String(sm).padStart(2,"0")}`;
    }
  } catch {}
  return null;
}

// Build a stable slot ISO for "today at HH:MM local" in the user's tz.
function slotISOForToday(hhmm: string, timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  const probe = new Date(`${y}-${m}-${d}T${hhmm}:00Z`);
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hour12: false });
  const tzOffsetMinutes = (Number(dtf.format(probe)) - probe.getUTCHours()) * 60;
  return new Date(probe.getTime() - tzOffsetMinutes * 60_000).toISOString();
}

const STYLE_PROMPTS: Record<string, string> = {
  pixar: "Professional Pixar-quality 3D animated still, ultra-detailed 8k render, dramatic cinematic lighting, shallow depth of field with dreamy bokeh, rich color grading",
  anime: "Studio Ghibli inspired 2D anime cel-shaded illustration, ultra-detailed, soft painterly backgrounds, warm color palette, cinematic composition",
  clay: "Stop-motion claymation still, tactile plasticine textures, hand-crafted charm, soft studio lighting, shallow depth of field",
  paper: "Paper cutout craft illustration, layered construction paper textures, soft shadows, warm storybook lighting",
  noir: "Cinematic film-noir 3D render, moody chiaroscuro lighting, deep contrast, dramatic rim light, muted color palette",
};


async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 3);
  const force = url.searchParams.get("force") === "1";
  const dryRun = url.searchParams.get("dryRun") === "1";
  const onlyUser = url.searchParams.get("user");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let query = supabaseAdmin.from("autopilot_settings").select("*");
  if (!force || !onlyUser) query = query.eq("enabled", true);
  if (onlyUser) query = query.eq("user_id", onlyUser);
  const { data: users, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Preview: what slots are due right now for each enabled user.
  const preview = (users || []).map((s) => {
    const slotTimes: string[] = (s.slot_times && s.slot_times.length ? s.slot_times : (s.slot_hours || []).map((h: number) => `${String(h).padStart(2,"0")}:00`));
    const pauseDays: number[] = s.pause_days || [];
    const matched = force ? (slotTimes[0] ?? "00:00") : isSlotDue(slotTimes, pauseDays, s.timezone);
    return {
      userId: s.user_id,
      enabled: s.enabled,
      timezone: s.timezone,
      slotTimes,
      pauseDays,
      dueSlot: matched,
      isDue: matched !== null,
    };
  });

  if (dryRun) {
    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      settingsFound: users?.length ?? 0,
      enabledUsers: (users || []).filter((s) => s.enabled).length,
      dueRightNow: preview.filter((p) => p.isDue).length,
      preview,
      message: users?.length
        ? "Autopilot settings found. Manual GitHub run can create and render a test short."
        : "No autopilot settings found. Open Autopilot, turn it on, and click Apply.",
      jobs: [],
      errors: [],
    });
  }

  const jobs: unknown[] = [];
  const errors: Array<{ userId: string; message: string }> = [];
  const skipped: Array<{ userId: string; reason: string }> = [];
  const { getFreshYouTubeAccessToken } = await import("@/lib/youtube-upload.server");
  for (const s of users || []) {
    if (jobs.length >= limit) break;
    const slotTimes: string[] = (s.slot_times && s.slot_times.length ? s.slot_times : (s.slot_hours || []).map((h: number) => `${String(h).padStart(2,"0")}:00`));
    const pauseDays: number[] = s.pause_days || [];
    const matched = force ? (slotTimes[0] ?? "00:00") : isSlotDue(slotTimes, pauseDays, s.timezone);
    if (matched === null) continue;

    // Preflight: don't burn AI credits if YouTube isn't connected/usable.
    try {
      await getFreshYouTubeAccessToken(supabaseAdmin, s.user_id);
    } catch (ytErr) {
      const msg = ytErr instanceof Error ? ytErr.message : String(ytErr);
      skipped.push({ userId: s.user_id, reason: msg });
      try {
        await supabaseAdmin.from("notifications").insert({
          user_id: s.user_id,
          title: "Autopilot skipped: YouTube not ready",
          message: `${msg} — open the Channel tab and reconnect YouTube.`,
        } as never);
      } catch {}
      continue;
    }

    const slotISO = force ? new Date().toISOString() : slotISOForToday(matched, s.timezone);
    void currentSlotKey; // preserved for backward-compat imports

    if (!force) {
      const { data: existing } = await supabaseAdmin
        .from("videos")
        .select("id")
        .eq("user_id", s.user_id)
        .eq("autopilot_slot", slotISO)
        .maybeSingle();
      if (existing) continue;
    }




    let reservedId: string | null = null;
    try {
      // Pick topic
      let storyPrompt: string;
      let rawTopic: string;
      let source: string;
      if (s.topic_mode === "niche" && s.niche) {
        storyPrompt = s.niche; rawTopic = s.niche; source = "niche";
      } else if (s.topic_mode === "mix" && s.niche && Math.random() < 0.5) {
        storyPrompt = s.niche; rawTopic = s.niche; source = "niche";
      } else {
        const t = await pickTrendingTopic(Date.now() + jobs.length);
        storyPrompt = t.storyPrompt; rawTopic = t.rawTopic; source = t.source;
      }

      const characterDesc = (CHARACTERS as Record<string, string>)[s.character_key] ?? CHARACTERS.ginger_cat;

      // Rotate story genre so each slot in the day feels different (funny, emotional, mystery, etc.).
      // Deterministic per (user, slot) so retries produce the same genre, but every slot differs.
      const GENRES = [
        { key: "funny",     brief: "laugh-out-loud slapstick comedy with a silly misunderstanding and a punchline twist" },
        { key: "emotional", brief: "heartwarming tear-jerker about kindness, friendship or a tiny act of love" },
        { key: "mystery",   brief: "curious mini-mystery where the character notices something odd and investigates" },
        { key: "wholesome", brief: "cozy feel-good slice-of-life moment that makes viewers smile" },
        { key: "adventure", brief: "small brave adventure with a mini obstacle and a triumphant beat" },
        { key: "underdog",  brief: "underdog story where the character overcomes doubt and wins in a small way" },
        { key: "twist",     brief: "unexpected plot twist ending that makes viewers rewatch to catch clues" },
        { key: "cliffhanger", brief: "dramatic cliffhanger that makes viewers desperate for part 2" },
      ];
      const genreSeed = Math.abs(
        Array.from(`${s.user_id}-${slotISO}`).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)
      );
      const genre = GENRES[genreSeed % GENRES.length];
      const blendedTone = `${s.tone} | GENRE THIS TIME: ${genre.key.toUpperCase()} — ${genre.brief}. Make the entire story fit this genre.`;
      const plan = await planStory(blendedTone, characterDesc, storyPrompt);

      // Reserve slot immediately (so a retry does not double-render)
      const { data: reserved, error: insErr } = await supabaseAdmin
        .from("videos")
        .insert({
          user_id: s.user_id,
          title: plan.title,
          description: plan.description,
          hashtags: plan.hashtags,
          status: "generating_video",
          generation_progress: 20,
          generation_stage: "Autopilot: generating assets",
          autopilot_slot: slotISO,
          script: JSON.parse(JSON.stringify(plan)),
        } as never)
        .select("id")
        .single();
      if (insErr) throw new Error(insErr.message);
      reservedId = reserved.id;

      // Generate free keyframes first; only spend TTS credits after images succeed.
      const images: string[] = [];
      for (const sc of plan.scenes) {
        const hint = EMOTION_HINTS[String(sc.emotion).toLowerCase()] ?? "expressive face";
        const prompt = `Professional Pixar-quality 3D animated still, ultra-detailed 8k render, dramatic cinematic lighting, shallow depth of field with dreamy bokeh, rich color grading, subject perfectly centered inside the vertical 9:16 safe area with headroom for captions at the bottom third. Character: ${characterDesc}, showing a clearly ${sc.emotion} expression: ${hint}. Action: ${sc.action}. Scene: ${sc.setting}. Camera: ${sc.cameraShot}, subtle rim light and soft key light, volumetric atmosphere. Single subject only. Negative: no text, no logos, no watermark, no borders, no letterboxing, no extra characters.`;
        images.push(await fetchPollinationsBase64(prompt, 1000 + sc.order * 137));
        await new Promise((r) => setTimeout(r, 1500));
      }
      const audios: string[] = [];
      for (const sc of plan.scenes) audios.push(await generateTtsBase64(sc.voiceover, s.voice));

      jobs.push({
        videoId: reservedId,
        userId: s.user_id,
        slotISO,
        privacy: s.privacy,
        plan,
        rawTopic,
        source,
        images, // base64 jpg each
        audios, // base64 mp3 each
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ userId: s.user_id, message: msg.slice(0, 500) });
      if (reservedId) {
        try {
          await supabaseAdmin.from("videos").update({
            status: "failed",
            error_message: msg.slice(0, 500),
            generation_stage: "Autopilot failed before rendering",
          } as never).eq("id", reservedId);
        } catch {}
      }
      try {
        await supabaseAdmin.from("notifications").insert({
          user_id: s.user_id,
          title: "Autopilot skipped a slot",
          message: msg.slice(0, 400),
        } as never);
      } catch {}
    }
  }

  return Response.json({ generatedAt: new Date().toISOString(), jobs, errors, skipped, preview });
}

export const Route = createFileRoute("/api/public/autopilot/tick")({
  server: { handlers: { GET: async ({ request }) => handler(request), POST: async ({ request }) => handler(request) } },
});
