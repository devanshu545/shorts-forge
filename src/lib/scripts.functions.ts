import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";


const InputSchema = z.object({
  niche: z.string().min(2).max(200),
  tone: z.string().min(2).max(80),
  hookStyle: z.string().min(2).max(80),
  durationSeconds: z.number().int().min(15).max(90),
});

const SceneSchema = z.object({
  order: z.number(),
  visualPrompt: z.string(),
  voiceover: z.string(),
  onScreenText: z.string(),
  durationSeconds: z.number(),
});

const ScriptSchema = z.object({
  title: z.string(),
  hook: z.string(),
  scenes: z.array(SceneSchema).min(2).max(10),
  fullVoiceover: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()).min(3).max(20),
  seoKeywords: z.array(z.string()).min(3).max(20),
});

export type GeneratedScript = z.infer<typeof ScriptSchema>;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("Model did not return JSON");
  return JSON.parse(candidate.slice(first, last + 1));
}

export const generateScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => InputSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY not configured");

    const provider = createLovableAiGatewayProvider(key);
    const model = provider("google/gemini-2.5-flash");

    const sceneCount = Math.max(3, Math.round(data.durationSeconds / 6));

    const systemPrompt = `You write viral YouTube Shorts scripts optimised for retention.
Return ONLY a JSON object (no markdown, no prose) exactly matching this TypeScript type:

{
  "title": string,             // <= 60 chars, SEO optimised
  "hook": string,              // 3-8 words, punchy opener
  "scenes": Array<{
    "order": number,           // 1-indexed
    "visualPrompt": string,    // concrete cinematic prompt for AI video (Veo)
    "voiceover": string,       // spoken line
    "onScreenText": string,    // short caption
    "durationSeconds": number  // 3-6
  }>,
  "fullVoiceover": string,     // concatenated voiceover
  "description": string,       // <= 300 chars
  "hashtags": string[],        // 5-10 items, each starts with #
  "seoKeywords": string[]      // 5-10 lowercase keywords
}`;

    const userPrompt = `Niche: ${data.niche}
Tone: ${data.tone}
Hook style: ${data.hookStyle}
Target duration: ${data.durationSeconds} seconds
Design exactly ${sceneCount} scenes whose durations sum to roughly ${data.durationSeconds} seconds.

Respond with the JSON object only.`;

    try {
      const { text } = await generateText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
      });
      const parsed = ScriptSchema.parse(extractJson(text));
      return { ok: true as const, script: parsed, userId: context.userId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429")) throw new Error("Rate limit hit. Try again in a moment.");
      if (msg.includes("402")) throw new Error("Out of Lovable AI credits. Top up your workspace to keep generating.");
      throw new Error(`Script generation failed: ${msg}`);
    }
  });

const SaveInputSchema = z.object({
  script: ScriptSchema,
  durationSeconds: z.number().int().min(15).max(90),
});

export const saveScriptAsDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => SaveInputSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("videos")
      .insert({
        user_id: context.userId,
        title: data.script.title,
        script: JSON.parse(JSON.stringify(data.script)),
        description: data.script.description,
        hashtags: data.script.hashtags,
        seo_keywords: data.script.seoKeywords,
        duration_seconds: data.durationSeconds,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });
