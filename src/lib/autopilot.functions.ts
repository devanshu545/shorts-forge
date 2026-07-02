import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const TestSchema = z.object({ baseUrl: z.string().url() });

export const runAutopilotTestNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => TestSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const secret = process.env.AUTOPILOT_SECRET;
    if (!secret) throw new Error("AUTOPILOT_SECRET not configured on the server.");
    const url = `${data.baseUrl.replace(/\/$/, "")}/api/public/autopilot/tick?dryRun=1&user=${context.userId}&limit=1`;
    const res = await fetch(url, { method: "POST", headers: { "x-autopilot-secret": secret } });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(typeof parsed === "object" && parsed && "error" in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 300));
    return parsed as { ok: boolean; generatedAt: string; settingsFound: number; message: string; jobs: [] };
  });


const SettingsSchema = z.object({
  enabled: z.boolean().default(false),
  videos_per_day: z.number().int().min(1).max(5).default(3),
  slot_hours: z.array(z.number().int().min(0).max(23)).min(1).max(5),
  topic_mode: z.enum(["trending", "niche", "mix"]).default("trending"),
  niche: z.string().max(400).nullable().optional(),
  tone: z.string().min(2).max(80).default("wholesome and funny"),
  character_key: z.string().min(2).max(60).default("ginger_cat"),
  voice: z.string().min(2).max(20).default("alloy"),
  privacy: z.enum(["public", "unlisted", "private"]).default("public"),
  timezone: z.string().min(1).max(80).default("UTC"),
});

export const getAutopilotSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("autopilot_settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

export const saveAutopilotSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => SettingsSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const row = {
      user_id: context.userId,
      ...data,
      slot_hours: data.slot_hours.slice(0, data.videos_per_day),
      updated_at: new Date().toISOString(),
    };
    const { data: saved, error } = await context.supabase
      .from("autopilot_settings")
      .upsert(row as never, { onConflict: "user_id" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return saved;
  });

export const listAutopilotVideos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("videos")
      .select("id,title,status,thumbnail_url,video_url,duration_seconds,autopilot_slot,youtube_video_id,created_at")
      .eq("user_id", context.userId)
      .not("autopilot_slot", "is", null)
      .order("autopilot_slot", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return data;
  });
