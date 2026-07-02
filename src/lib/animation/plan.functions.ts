import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

// Enums picked to match the client-side renderer capabilities.
export const BACKGROUNDS = ["park", "city", "kitchen", "sky", "office", "gym", "beach", "space", "classroom", "stage", "cafe", "street"] as const;
export const ACTIONS = ["idle", "walk", "run", "jump", "wave", "spin", "fall", "dance", "chase", "punch", "celebrate", "think", "cry", "laugh", "shock", "love"] as const;
export const PROPS = ["none", "ball", "heart", "money", "star", "lightning", "question", "coffee", "phone", "gift", "trophy", "bomb", "fire"] as const;
export const COLORS = ["#ff6b6b", "#4ecdc4", "#ffd93d", "#a78bfa", "#ff8a5b", "#7ee787", "#f472b6", "#60a5fa"] as const;

const CharacterSchema = z.object({
  id: z.string(),
  color: z.string(),
  action: z.enum(ACTIONS),
  startX: z.number().min(0).max(1),
  startY: z.number().min(0).max(1),
  direction: z.enum(["left", "right"]).default("right"),
  scale: z.number().min(0.5).max(2).default(1),
});

const SceneSchema = z.object({
  background: z.enum(BACKGROUNDS),
  durationSeconds: z.number().min(2).max(10),
  characters: z.array(CharacterSchema).min(1).max(3),
  prop: z.enum(PROPS).default("none"),
  captionEmoji: z.string().max(4).default(""),
});

export const AnimationPlanSchema = z.object({
  scenes: z.array(SceneSchema).min(2).max(10),
});

export type AnimationPlan = z.infer<typeof AnimationPlanSchema>;

const InputSchema = z.object({
  scenes: z.array(z.object({
    order: z.number(),
    visualPrompt: z.string(),
    voiceover: z.string(),
    onScreenText: z.string(),
    durationSeconds: z.number(),
  })).min(1),
  title: z.string(),
});

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("Model did not return JSON");
  const raw = candidate.slice(first, last + 1);
  try { return JSON.parse(raw); } catch { return JSON.parse(jsonrepair(raw)); }
}

export const planAnimation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => InputSchema.parse(raw))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY not configured");
    const provider = createLovableAiGatewayProvider(key);
    const model = provider("google/gemini-2.5-flash");

    const system = `You are a storyboard artist for silent animated YouTube Shorts starring emoji-style stick characters (like Pixar minis meets Duolingo). Convert the input script into a JSON animation plan. The video has NO sound and NO captions — the visuals + character body language + a single big emoji reaction per scene must tell the story clearly and be engaging/funny.

Return ONLY JSON:
{
  "scenes": [
    {
      "background": one of ${JSON.stringify(BACKGROUNDS)},
      "durationSeconds": number (2-10, match the input scene duration),
      "characters": [ // 1 to 3
        {
          "id": short unique string,
          "color": one of ${JSON.stringify(COLORS)},
          "action": one of ${JSON.stringify(ACTIONS)},
          "startX": 0..1 (horizontal position, 0=left 1=right),
          "startY": 0.55..0.85 (vertical position on 9:16 canvas, keep on ground unless jumping/flying),
          "direction": "left" or "right",
          "scale": 0.8 to 1.4
        }
      ],
      "prop": one of ${JSON.stringify(PROPS)},
      "captionEmoji": short emoji string (1-2 emojis) that punctuates the scene, or "" if none
    }
  ]
}

Rules:
- Match one scene per input scene, same order and roughly the same duration.
- Pick actions that visually match the visualPrompt/voiceover.
- Make it FUNNY and visually clear without words — pick expressive actions (fall, shock, celebrate, chase).
- Vary characters and backgrounds across scenes; keep character ids/colors consistent when it's the same character.
- Return ONLY the JSON object.`;

    const compact = data.scenes.map((s) => `Scene ${s.order} (${s.durationSeconds}s):\n  Visual: ${s.visualPrompt}\n  VO: ${s.voiceover}\n  Text: ${s.onScreenText}`).join("\n\n");
    const prompt = `Title: ${data.title}\n\n${compact}\n\nGenerate the JSON animation plan.`;

    const { text } = await generateText({ model, system, prompt });
    return AnimationPlanSchema.parse(extractJson(text));
  });
