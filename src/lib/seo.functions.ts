import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Generate SEO title/description/tags/hashtags for a Short from a hint.
// Uses Lovable AI Gateway (Gemini). Returns safe defaults on failure so the
// upload flow never blocks.
export const generateShortSEO = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z.object({
      hint: z.string().min(1).max(400),
      existingTitle: z.string().optional(),
    }).parse(raw),
  )
  .handler(async ({ data }) => {
    const fallback = {
      title: (data.existingTitle || data.hint).slice(0, 60),
      description: `${data.hint}\n\n#shorts #shortsfeed #viral #fyp #trending`,
      tags: ["shorts", "shorts fyp", "shortsfeed", "viral", "trending", "youtube shorts"],
      hashtags: ["#shorts", "#shortsfeed", "#viral", "#fyp", "#trending"],
    };
    try {
      const apiKey = process.env.LOVABLE_API_KEY;
      if (!apiKey) return fallback;
      const prompt = `You are a YouTube Shorts SEO expert. Given this clip hint, return a JSON object with:
- title: catchy, ≤60 chars, include 1-2 emojis, no clickbait quotes
- description: 2-3 short lines + 8 relevant hashtags at the end
- tags: array of 15 lowercase SEO tags
- hashtags: array of 8 hashtags starting with #

Hint: ${data.hint}

Return ONLY the JSON. No markdown.`;
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.8,
        }),
      });
      const j = await res.json();
      const raw = j?.choices?.[0]?.message?.content || "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      return {
        title: String(parsed.title || fallback.title).slice(0, 60),
        description: String(parsed.description || fallback.description).slice(0, 4900),
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 15).map(String) : fallback.tags,
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 8).map(String) : fallback.hashtags,
      };
    } catch {
      return fallback;
    }
  });
