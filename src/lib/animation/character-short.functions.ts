import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

// -------------------- Plan --------------------
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

const PlanInputSchema = z.object({
  characterKey: z.string().min(2),
  characterDescription: z.string().min(10).max(600), // resolved by client from CHARACTERS map or custom
  topic: z.string().min(3).max(200),
  tone: z.string().min(2).max(60).default("wholesome"),
});

const SceneBeatSchema = z.object({
  order: z.number().int().min(1).max(4),
  setting: z.string().max(200),
  action: z.string().max(200),
  cameraShot: z.string().max(120),
  mood: z.string().max(60),
  durationSeconds: z.union([z.literal(5), z.literal(5)]).default(5),
});

export const CharacterPlanSchema = z.object({
  title: z.string().max(80),
  hook: z.string().max(120),
  description: z.string().max(400),
  hashtags: z.array(z.string()).min(3).max(12),
  scenes: z.array(SceneBeatSchema).length(4),
  cta: z.object({
    top: z.string().max(40).default("Comment for part 2"),
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

    const system = `You script viral YouTube Shorts about a single recurring 3D-animated character.
Return ONLY a JSON object matching this TypeScript type:
{
  "title": string,                // <=60 chars, catchy
  "hook": string,                 // <=100 chars, first-scene tease
  "description": string,          // <=300 chars, YouTube description
  "hashtags": string[],           // 5-8 items, each starts with #
  "scenes": [                     // EXACTLY 4 scenes, each 5 seconds
    {"order":1,"setting":string,"action":string,"cameraShot":string,"mood":string,"durationSeconds":5},
    {"order":2,...},{"order":3,...},{"order":4,...}
  ],
  "cta": {"top":"Comment for part 2","bottom":"SUBSCRIBE"}
}
Rules:
- setting = concrete environment (e.g. "sunlit pond with wooden dock in green rolling hills").
- action = ONE simple physical action the character does in that scene (e.g. "sits on dock and casts a fishing rod, watching the bobber").
- cameraShot = one of: "wide establishing", "medium shot", "close-up front", "over-the-shoulder", "low-angle hero".
- Never describe dialogue, text overlays, or other characters. Only the single hero character.
- Scene 1 = introduction / hook. Scene 4 = emotional payoff where character looks at camera.`;

    const user = `Character: ${data.characterDescription}
Topic / story: ${data.topic}
Tone: ${data.tone}

Design 4 scenes that tell this story visually. Return the JSON only.`;

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

// -------------------- Keyframe (Lovable AI image gen) --------------------
const KeyframeInputSchema = z.object({
  videoId: z.string().uuid(),
  sceneOrder: z.number().int().min(1).max(4),
  characterDescription: z.string().min(10).max(600),
  setting: z.string().min(3).max(300),
  action: z.string().min(3).max(300),
  cameraShot: z.string().max(120),
});

async function callLovableImage(prompt: string): Promise<Uint8Array> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY not configured");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-image-2",
      prompt,
      size: "1024x1536",
      quality: "low",
      n: 1,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 402) throw new Error("Out of Lovable AI credits. Top up to keep generating.");
    if (res.status === 429) throw new Error("Rate limited. Try again in a moment.");
    throw new Error(`Image generation failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = body.data?.[0];
  if (!first) throw new Error("Image API returned no data");
  if (first.b64_json) {
    const bin = atob(first.b64_json);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (first.url) {
    const r = await fetch(first.url);
    if (!r.ok) throw new Error(`Failed to download generated image (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  }
  throw new Error("Image API returned no image payload");
}

export const generateSceneKeyframe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => KeyframeInputSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const prompt = `${data.characterDescription}. ${data.action}. Scene: ${data.setting}. ${data.cameraShot}. Cinematic 3D Pixar-quality rendering, vertical 9:16 composition, soft rim lighting, storybook color palette, single subject only.`;
    const bytes = await callLovableImage(prompt);
    const path = `${context.userId}/${data.videoId}/keyframes/${data.sceneOrder}.png`;
    const { error: upErr } = await context.supabase.storage
      .from("videos")
      .upload(path, bytes, { contentType: "image/png", upsert: true });
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);
    const { data: signed, error: signErr } = await context.supabase.storage
      .from("videos")
      .createSignedUrl(path, 60 * 60 * 2);
    if (signErr || !signed) throw new Error(`Signed URL failed: ${signErr?.message}`);
    return { path, url: signed.signedUrl };
  });

// -------------------- Clip (fal.ai Kling image-to-video) --------------------
const ClipInputSchema = z.object({
  videoId: z.string().uuid(),
  sceneOrder: z.number().int().min(1).max(4),
  imageUrl: z.string().url(),
  prompt: z.string().min(3).max(600),
  durationSeconds: z.union([z.literal(5), z.literal(10)]).default(5),
});

async function falKlingImageToVideo(opts: {
  imageUrl: string;
  prompt: string;
  duration: 5 | 10;
}): Promise<string> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY not configured");
  const submit = await fetch(
    "https://queue.fal.run/fal-ai/kling-video/v1.6/standard/image-to-video",
    {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: opts.imageUrl,
        prompt: opts.prompt,
        duration: String(opts.duration),
        aspect_ratio: "9:16",
        cfg_scale: 0.5,
      }),
    },
  );
  if (!submit.ok) {
    const text = await submit.text();
    if (submit.status === 403 && /balance|locked|exhaust/i.test(text)) {
      throw new Error(
        "fal.ai balance is empty. Top up at https://fal.ai/dashboard/billing (minimum $5) then try again.",
      );
    }
    if (submit.status === 401) {
      throw new Error("fal.ai key rejected. Check the FAL_KEY secret is a valid key from fal.ai/dashboard/keys.");
    }
    throw new Error(`fal submit failed (${submit.status}): ${text.slice(0, 300)}`);
  }
  const submitted = (await submit.json()) as {
    request_id: string;
    status_url: string;
    response_url: string;
  };

  // Poll up to ~5 minutes
  const started = Date.now();
  const deadline = started + 5 * 60 * 1000;
  let delay = 4000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    const st = await fetch(submitted.status_url, { headers: { Authorization: `Key ${key}` } });
    if (!st.ok) {
      const t = await st.text();
      throw new Error(`fal status failed (${st.status}): ${t.slice(0, 200)}`);
    }
    const body = (await st.json()) as { status: string };
    if (body.status === "COMPLETED") break;
    if (body.status === "FAILED" || body.status === "ERROR") {
      throw new Error(`fal generation ${body.status.toLowerCase()}`);
    }
    delay = Math.min(delay + 1000, 8000);
  }

  const final = await fetch(submitted.response_url, {
    headers: { Authorization: `Key ${key}` },
  });
  if (!final.ok) {
    const t = await final.text();
    throw new Error(`fal response fetch failed (${final.status}): ${t.slice(0, 200)}`);
  }
  const payload = (await final.json()) as { video?: { url?: string } };
  const videoUrl = payload.video?.url;
  if (!videoUrl) throw new Error("fal returned no video url");
  return videoUrl;
}

export const generateSceneClip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => ClipInputSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const falUrl = await falKlingImageToVideo({
      imageUrl: data.imageUrl,
      prompt: data.prompt,
      duration: data.durationSeconds,
    });
    // Re-host on Supabase for CORS-safe client stitching
    const dl = await fetch(falUrl);
    if (!dl.ok) throw new Error(`Failed downloading fal video (${dl.status})`);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const path = `${context.userId}/${data.videoId}/clips/${data.sceneOrder}.mp4`;
    const { error: upErr } = await context.supabase.storage
      .from("videos")
      .upload(path, bytes, { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error(`Clip upload failed: ${upErr.message}`);
    const { data: signed, error: signErr } = await context.supabase.storage
      .from("videos")
      .createSignedUrl(path, 60 * 60 * 6);
    if (signErr || !signed) throw new Error(`Clip signed URL failed: ${signErr?.message}`);
    return { path, url: signed.signedUrl, bytes: bytes.length };
  });

// -------------------- Finalize (mark row ready with stitched video) --------------------
const FinalizeSchema = z.object({
  videoId: z.string().uuid(),
  storagePath: z.string().min(3),
  signedUrl: z.string().url(),
  fileSize: z.number().int().min(1),
  durationSeconds: z.number().min(1).max(60),
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
