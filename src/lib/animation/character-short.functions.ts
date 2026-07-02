import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

// -------------------- Character presets --------------------
export const CHARACTERS = {
  ginger_cat:
    "chubby fluffy ginger tabby cat, huge round emerald green eyes, tiny pink triangular nose, small white chest patch, wearing a thin gold chain necklace with a shiny gold letter 'S' pendant, expressive cartoon face, 3D Pixar-quality rendering, soft studio lighting, DreamWorks style",
  golden_puppy:
    "adorable fluffy golden retriever puppy, bright soulful brown eyes, tiny black nose, soft golden fur, wearing a small red collar with a silver bone tag, cartoon proportions with a big head and small body, 3D Pixar-quality rendering, warm cinematic lighting",
  panda_cub:
    "tiny round panda cub, huge glossy black eyes, small black nose, chubby cheeks, oversized head, wearing a tiny green bamboo-leaf bandana around the neck, 3D Pixar-quality rendering, soft daylight",
  bunny:
    "small fluffy white bunny rabbit, huge sparkling blue eyes, long floppy ears with pink inner lining, tiny pink nose, wearing a lavender ribbon around the neck, cartoon proportions, 3D Pixar-quality rendering, dreamy soft lighting",
  fox_kit:
    "cute little orange fox kit, bright amber eyes, black-tipped ears and paws, fluffy white-tipped tail, wearing a small brown leather satchel across the chest, 3D Pixar-quality rendering, golden hour lighting",
  baby_elephant:
    "tiny grey baby elephant, huge sparkly brown eyes, floppy ears, short curled trunk, chubby cartoon body, wearing a small yellow polka-dot scarf, 3D Pixar-quality rendering, soft cinematic lighting",
  duckling:
    "fluffy yellow duckling, huge round black eyes, tiny orange beak, small orange webbed feet, wearing a mini blue bow-tie, cartoon proportions, 3D Pixar-quality rendering, bright soft daylight",
} as const;
export type CharacterKey = keyof typeof CHARACTERS;

export const VOICES = ["alloy", "nova", "shimmer", "echo", "onyx", "fable"] as const;
export type VoiceKey = (typeof VOICES)[number];

export const EMOTIONS = [
  "happy",
  "curious",
  "surprised",
  "sad",
  "determined",
  "proud",
  "sleepy",
  "excited",
  "scared",
  "hopeful",
] as const;

// Visual cues we inject into the image prompt so Flux actually draws the expression.
const EMOTION_HINTS: Record<string, string> = {
  happy: "wide joyful smile, sparkling eyes, cheeks slightly raised",
  curious: "head tilted, one ear up, wide inquisitive eyes, mouth slightly open",
  surprised: "eyes huge and wide open, mouth in a small round O, ears perked straight up",
  sad: "droopy eyes, small frown, ears folded down, tiny tear glistening",
  determined: "focused narrowed eyes, tight closed mouth, brows slightly furrowed, confident pose",
  proud: "chest puffed out, chin up, gentle satisfied smile, eyes half-closed with contentment",
  sleepy: "half-closed drowsy eyes, tiny yawn, relaxed floppy posture",
  excited: "huge grin showing tiny teeth, sparkling eyes, jumping pose, motion lines",
  scared: "trembling, eyes huge with tiny pupils, ears flat back, hunched shoulders",
  hopeful: "gentle warm smile, soft dreamy eyes looking up, one paw raised",
};

// -------------------- Plan (Lovable AI free Gemini) --------------------
const PlanInputSchema = z.object({
  characterKey: z.string().min(2),
  characterDescription: z.string().min(10).max(600),
  topic: z.string().min(3).max(200),
  tone: z.string().min(2).max(60).default("wholesome"),
});

const EmotionField = z.preprocess((v) => {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "happy";
  if (typeof v === "string" && v.trim()) return v.trim();
  return "happy";
}, z.string().max(40));

const SceneBeatSchema = z.object({
  order: z.number().int().min(1).max(4),
  setting: z.string().max(200),
  action: z.string().max(200),
  cameraShot: z.string().max(120),
  mood: z.string().max(60),
  emotion: EmotionField,
  voiceover: z.string().min(3).max(220),
  durationSeconds: z.union([z.literal(5), z.literal(5)]).default(5),
});


export const CharacterPlanSchema = z.object({
  title: z.string().max(80),
  hook: z.string().max(120),
  description: z.string().max(400),
  hashtags: z.array(z.string()).min(3).max(12),
  scenes: z.array(SceneBeatSchema).length(4),
  cta: z.object({
    top: z.string().max(40).default("Sub for part 2 👇"),
    bottom: z.string().max(20).default("SUBSCRIBE"),
  }),
});
export type CharacterPlan = z.infer<typeof CharacterPlanSchema>;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("Model did not return JSON");
  const raw = candidate.slice(first, last + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(jsonrepair(raw));
  }
}

export const planCharacterShort = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => PlanInputSchema.parse(raw))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY not configured");
    const provider = createLovableAiGatewayProvider(key);
    const model = provider("google/gemini-2.5-flash");

    const emotionList = EMOTIONS.join(" | ");
    const system = `You script viral narrated YouTube Shorts about a single recurring 3D-animated character.
Return ONLY a JSON object matching:
{
  "title": string,                 // <=60 chars, catchy
  "hook": string,                  // <=100 chars, first-scene tease
  "description": string,           // <=300 chars, YouTube description
  "hashtags": string[],            // 5-8 items, each starts with #
  "scenes": [                      // EXACTLY 4 scenes
    {
      "order": 1,
      "setting": string,           // concrete environment
      "action": string,            // ONE physical action the character does
      "cameraShot": "wide establishing" | "medium shot" | "close-up front" | "over-the-shoulder" | "low-angle hero",
      "mood": string,              // 1-3 word mood
      "emotion": ${JSON.stringify(EMOTIONS)},   // pick ONE — drives face expression in the image
      "voiceover": string          // 1-2 short spoken sentences, <= 22 words, told by a warm narrator ABOUT the character (third person). No stage directions, no quotes, no sound effects.
    },
    { "order": 2, ... },
    { "order": 3, ... },
    { "order": 4, ... }
  ],
  "cta": { "top": "Sub for part 2 👇", "bottom": "SUBSCRIBE" }
}
Rules:
- Only the single hero character is in each scene.
- The 4 voiceovers together tell one continuous story: setup → complication → turn → payoff.
- Scene 4 is the emotional payoff AND opens a natural cliffhanger for a "part 2".
- emotion must be one of: ${emotionList}.`;

    const user = `Character: ${data.characterDescription}
Topic / story: ${data.topic}
Tone: ${data.tone}

Design 4 scenes with narration + emotion. Return the JSON only.`;

    try {
      const { text } = await generateText({ model, system, prompt: user });
      const parsed = CharacterPlanSchema.parse(extractJson(text));
      return { plan: parsed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429")) throw new Error("Rate limit hit. Try again in a moment.");
      if (msg.includes("402")) throw new Error("Out of Lovable AI credits. Top up to keep generating.");
      throw new Error(`Plan failed: ${msg}`);
    }
  });

// -------------------- Keyframe (Pollinations — free, no API key) --------------------
const KeyframeInputSchema = z.object({
  videoId: z.string().uuid(),
  sceneOrder: z.number().int().min(1).max(4),
  characterDescription: z.string().min(10).max(600),
  setting: z.string().min(3).max(300),
  action: z.string().min(3).max(300),
  cameraShot: z.string().max(120),
  emotion: z.string().max(40).default("happy"),
});

async function fetchPollinationsImage(prompt: string, seed: number): Promise<Uint8Array> {
  const encoded = encodeURIComponent(prompt.slice(0, 900));
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=720&height=1280&nologo=true&enhance=true&model=flux&seed=${seed}`;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "image/*" } });
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > 2000) return buf;
        lastErr = `empty response (${buf.byteLength} bytes)`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
  }
  throw new Error(`Pollinations image failed after retries: ${lastErr}`);
}

export const generateSceneKeyframe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => KeyframeInputSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const emotionHint = EMOTION_HINTS[data.emotion.toLowerCase()] ?? "expressive face";
    const prompt = `${data.characterDescription}, showing a clearly ${data.emotion} expression: ${emotionHint}. ${data.action}. Scene: ${data.setting}. ${data.cameraShot}. Cinematic 3D Pixar-quality rendering, vertical 9:16 composition, soft rim lighting, storybook color palette, ultra detailed, single subject only, no text, no watermark, no logo.`;
    const seed = 1000 + data.sceneOrder * 137;
    const bytes = await fetchPollinationsImage(prompt, seed);
    const path = `${context.userId}/${data.videoId}/keyframes/${data.sceneOrder}.jpg`;
    const { error: upErr } = await context.supabase.storage
      .from("videos")
      .upload(path, bytes, { contentType: "image/jpeg", upsert: true });
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);
    const { data: signed, error: signErr } = await context.supabase.storage
      .from("videos")
      .createSignedUrl(path, 60 * 60 * 6);
    if (signErr || !signed) throw new Error(`Signed URL failed: ${signErr?.message}`);
    return { path, url: signed.signedUrl };
  });

// -------------------- Voiceover (Lovable AI TTS — openai/gpt-4o-mini-tts) --------------------
const VoiceoverInputSchema = z.object({
  videoId: z.string().uuid(),
  sceneOrder: z.number().int().min(1).max(4),
  text: z.string().min(1).max(500),
  voice: z.enum(VOICES).default("alloy"),
});

export const generateSceneVoiceover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => VoiceoverInputSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY not configured");
    const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini-tts",
        input: data.text,
        voice: data.voice,
        response_format: "mp3",
        instructions:
          "Narrate warmly and expressively like a cozy children's storybook narrator, natural pacing, gentle energy.",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 402) throw new Error("Out of Lovable AI credits. Top up to keep generating narration.");
      if (res.status === 429) throw new Error("TTS rate limited. Try again in a moment.");
      throw new Error(`TTS failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const path = `${context.userId}/${data.videoId}/audio/scene-${data.sceneOrder}.mp3`;
    const { error: upErr } = await context.supabase.storage
      .from("audio")
      .upload(path, bytes, { contentType: "audio/mpeg", upsert: true });
    if (upErr) throw new Error(`Audio upload failed: ${upErr.message}`);
    const { data: signed, error: signErr } = await context.supabase.storage
      .from("audio")
      .createSignedUrl(path, 60 * 60 * 6);
    if (signErr || !signed) throw new Error(`Audio signed URL failed: ${signErr?.message}`);
    return { path, url: signed.signedUrl, bytes: bytes.length };
  });

// -------------------- Finalize --------------------
const FinalizeSchema = z.object({
  videoId: z.string().uuid(),
  storagePath: z.string().min(3),
  signedUrl: z.string().url(),
  fileSize: z.number().int().min(1),
  durationSeconds: z.number().min(1).max(120),
});

export const finalizeCharacterShort = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => FinalizeSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("videos")
      .update({
        status: "ready",
        video_url: data.signedUrl,
        video_storage_path: data.storagePath,
        file_size_bytes: data.fileSize,
        duration_seconds: data.durationSeconds,
        generation_progress: 100,
        generation_stage: "Video ready! 🎉",
        error_message: null,
      } as never)
      .eq("id", data.videoId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const FailSchema = z.object({
  videoId: z.string().uuid(),
  message: z.string().min(1).max(500),
});
export const failCharacterShort = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => FailSchema.parse(raw))
  .handler(async ({ data, context }) => {
    await context.supabase
      .from("videos")
      .update({
        status: "failed",
        error_message: data.message,
        generation_stage: "Failed",
      } as never)
      .eq("id", data.videoId)
      .eq("user_id", context.userId);
    return { ok: true };
  });
