import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

const InputSchema = z.object({
  niche: z.string().min(2).max(200),
  tone: z.string().min(2).max(80),
  hookStyle: z.string().min(2).max(80),
  durationSeconds: z.number().int().min(15).max(90),
});

const ScriptSchema = z.object({
  title: z.string(),
  hook: z.string(),
  scenes: z.array(z.object({
    order: z.number(),
    visualPrompt: z.string(),
    voiceover: z.string(),
    onScreenText: z.string(),
    durationSeconds: z.number(),
  })).min(2).max(8),
  fullVoiceover: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()).min(3).max(20),
  seoKeywords: z.array(z.string()).min(3).max(20),
});

export type GeneratedScript = z.infer<typeof ScriptSchema>;

export const generateScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => InputSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY not configured");

    const provider = createLovableAiGatewayProvider(key);
    const model = provider("google/gemini-3-flash-preview");

    const systemPrompt = `You write viral YouTube Shorts scripts optimised for retention. Every script has:
- A punchy 3-5 word hook
- Scenes broken into 3-5 second beats, each with a concrete visual prompt suitable for AI video generation, a spoken voiceover line, and short on-screen text
- Total spoken duration matching the target
- SEO-optimised title (<=60 chars), description (<=300 chars) with 2-3 relevant hashtags in body, and a hashtag list.
Return strict JSON matching the schema. No markdown.`;

    const userPrompt = `Niche: ${data.niche}
Tone: ${data.tone}
Hook style: ${data.hookStyle}
Target duration: ${data.durationSeconds} seconds

Design ${Math.max(3, Math.round(data.durationSeconds / 6))} scenes.`;

    try {
      const { output } = await generateText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        output: Output.object({ schema: ScriptSchema }),
      });
      return { ok: true as const, script: output, userId: context.userId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429")) throw new Error("Rate limit hit. Try again in a moment.");
      if (msg.includes("402")) throw new Error("Out of Lovable credits. Top up your workspace to keep generating.");
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
