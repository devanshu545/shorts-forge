import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Hard-cap AI titles to keep them readable on Shorts mobile UI. ≤40 chars.
const MAX_TITLE = 40;

function clampTitle(raw: string): string {
  const t = raw.replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ");
  if (t.length <= MAX_TITLE) return t;
  // Trim on word boundary just before the cap.
  const cut = t.slice(0, MAX_TITLE);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

// Generate SEO title/description/tags for a Short based on real content:
// if `frames` (JPEG data URLs) are provided we use Gemini vision so the
// title actually describes what's on screen instead of a generic hook.
export const generateShortSEO = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z.object({
      hint: z.string().min(1).max(400),
      existingTitle: z.string().optional(),
      // data:image/jpeg;base64,... — up to 3 frames from the clip.
      frames: z.array(z.string().startsWith("data:image/")).max(4).optional(),
      transcript: z.string().max(4000).optional(),
    }).parse(raw),
  )
  .handler(async ({ data }) => {
    const fallbackTitle = clampTitle(data.existingTitle || data.hint);
    const fallback = {
      title: fallbackTitle,
      description: `${data.hint}\n\n#shorts #shortsfeed #viral #fyp #trending`,
      tags: ["shorts", "shorts fyp", "shortsfeed", "viral", "trending", "youtube shorts"],
      hashtags: ["#shorts", "#shortsfeed", "#viral", "#fyp", "#trending"],
    };

    try {
      const apiKey = process.env.LOVABLE_API_KEY;
      if (!apiKey) return fallback;

      const useVision = Array.isArray(data.frames) && data.frames.length > 0;
      const promptText = `You are a YouTube Shorts SEO expert. ${useVision
        ? "You are seeing sampled frames from the short. Base the title on what is ACTUALLY visible."
        : ""}
${data.transcript ? `Spoken words in the clip: """${data.transcript.slice(0, 1500)}"""` : ""}
Context hint: ${data.hint}

Return a JSON object with:
- title: MAX 40 CHARACTERS. Hook-first, punchy, describes real content. Max 1 emoji. No clickbait quotes. No colons unless needed.
- description: 2-3 short lines + 8 relevant hashtags at the end.
- tags: array of 15 lowercase SEO tags.
- hashtags: array of 8 hashtags starting with #.

Return ONLY the JSON. No markdown.`;

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      > = [{ type: "text", text: promptText }];
      if (useVision) {
        for (const f of data.frames!) {
          content.push({ type: "image_url", image_url: { url: f } });
        }
      }

      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content }],
          temperature: 0.85,
        }),
      });
      if (!res.ok) return fallback;
      const j = await res.json();
      const raw = j?.choices?.[0]?.message?.content || "";
      const clean = String(raw).replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      return {
        title: clampTitle(String(parsed.title || fallback.title)),
        description: String(parsed.description || fallback.description).slice(0, 4900),
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 15).map(String) : fallback.tags,
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 8).map(String) : fallback.hashtags,
      };
    } catch {
      return fallback;
    }
  });
