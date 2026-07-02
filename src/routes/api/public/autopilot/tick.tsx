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
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=720&height=1280&nologo=true&enhance=true&model=flux&seed=${seed}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "image/*" } });
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > 2000) return Buffer.from(buf).toString("base64");
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1200 + attempt * 1200));
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

function currentSlotKey(hour: number) {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(hour).padStart(2, "0")}`;
}

function isSlotDue(slotHours: number[], timezone: string): number | null {
  // Compute current hour in user's timezone; if it matches a slot, return that hour (UTC-marked as slot key).
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: timezone });
    const localHour = Number(fmt.format(now));
    if (slotHours.includes(localHour)) return now.getUTCHours();
  } catch {}
  return null;
}

async function handler(request: Request): Promise<Response> {
  const secret = process.env.AUTOPILOT_SECRET;
  const provided = request.headers.get("x-autopilot-secret") || new URL(request.url).searchParams.get("secret");
  if (!secret || provided !== secret) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 3);
  const force = url.searchParams.get("force") === "1";
  const dryRun = url.searchParams.get("dryRun") === "1";
  const onlyUser = url.searchParams.get("user");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let query = supabaseAdmin.from("autopilot_settings").select("*");
  if (!force) query = query.eq("enabled", true);
  if (onlyUser) query = query.eq("user_id", onlyUser);
  const { data: users, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  if (dryRun) {
    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      settingsFound: users?.length ?? 0,
      enabledUsers: (users || []).filter((s) => s.enabled).length,
      message: users?.length
        ? "Autopilot settings found. Manual GitHub run can create and render a test short."
        : "No autopilot settings found. Open Autopilot, turn it on, and click Apply.",
      jobs: [],
      errors: [],
    });
  }

  const jobs: unknown[] = [];
  const errors: Array<{ userId: string; message: string }> = [];
  for (const s of users || []) {
    if (jobs.length >= limit) break;
    const utcHour = force ? new Date().getUTCHours() : isSlotDue(s.slot_hours, s.timezone);
    if (utcHour === null) continue;

    const slotKey = currentSlotKey(utcHour);
    const slotISO = force
      ? new Date().toISOString()
      : new Date(`${slotKey.slice(0, 10)}T${slotKey.slice(11)}:00:00Z`).toISOString();


    if (!force) {
      const { data: existing } = await supabaseAdmin
        .from("videos")
        .select("id")
        .eq("user_id", s.user_id)
        .eq("autopilot_slot", slotISO)
        .maybeSingle();
      if (existing) continue;
    }


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
      const plan = await planStory(s.tone, characterDesc, storyPrompt);

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

      // Render assets in parallel: 4 keyframes + 4 audio
      const kfPromises = plan.scenes.map((sc) => {
        const hint = EMOTION_HINTS[String(sc.emotion).toLowerCase()] ?? "expressive face";
        const prompt = `${characterDesc}, showing a clearly ${sc.emotion} expression: ${hint}. ${sc.action}. Scene: ${sc.setting}. ${sc.cameraShot}. Cinematic 3D Pixar-quality, vertical 9:16, soft rim lighting, single subject only, no text, no watermark.`;
        return fetchPollinationsBase64(prompt, 1000 + sc.order * 137);
      });
      const audioPromises = plan.scenes.map((sc) => generateTtsBase64(sc.voiceover, s.voice));
      const [images, audios] = await Promise.all([Promise.all(kfPromises), Promise.all(audioPromises)]);

      jobs.push({
        videoId: reserved.id,
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
      try {
        await supabaseAdmin.from("notifications").insert({
          user_id: s.user_id,
          title: "Autopilot skipped a slot",
          message: msg.slice(0, 400),
        } as never);
      } catch {}
    }
  }

  return Response.json({ generatedAt: new Date().toISOString(), jobs, errors });
}

export const Route = createFileRoute("/api/public/autopilot/tick")({
  server: { handlers: { GET: async ({ request }) => handler(request), POST: async ({ request }) => handler(request) } },
});
