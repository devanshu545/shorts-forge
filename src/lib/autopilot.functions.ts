import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { pickTrendingTopic } from "@/lib/trending.server";
import { CHARACTERS } from "@/lib/animation/character-short.functions";

export const pickAutopilotTopic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: s } = await context.supabase
      .from("autopilot_settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    const settings = s ?? null;
    const mode = settings?.topic_mode ?? "trending";
    const niche = settings?.niche?.trim() || "";
    let storyPrompt = "";
    let source = "fallback";
    let rawTopic = "";
    if (mode === "niche" && niche) {
      storyPrompt = niche; rawTopic = niche; source = "niche";
    } else if (mode === "mix" && niche && Math.random() < 0.5) {
      storyPrompt = niche; rawTopic = niche; source = "niche";
    } else {
      const t = await pickTrendingTopic(Date.now());
      storyPrompt = t.storyPrompt; rawTopic = t.rawTopic; source = t.source;
    }
    const characterKey = settings?.character_key ?? "ginger_cat";
    const characterDescription = (CHARACTERS as Record<string, string>)[characterKey] ?? CHARACTERS.ginger_cat;
    return {
      storyPrompt,
      rawTopic,
      source,
      characterKey,
      characterDescription,
      tone: settings?.tone ?? "wholesome and funny",
      voice: settings?.voice ?? "alloy",
      privacy: (settings?.privacy ?? "public") as "public" | "unlisted" | "private",
    };
  });

export const getLatestAutopilotTestVideo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("videos")
      .select("id,title,description,tags,hashtags,video_url,thumbnail_url,youtube_video_id,status,created_at")
      .eq("user_id", context.userId)
      .eq("status", "ready")
      .is("youtube_video_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });


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

function computeUpcomingSlots(slotHours: number[], timezone: string, count = 3): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let dayOffset = 0; dayOffset < 3 && out.length < count; dayOffset += 1) {
    const day = new Date(now.getTime() + dayOffset * 86400_000);
    for (const h of [...slotHours].sort((a, b) => a - b)) {
      // Build a Date that represents "today at hour h in the user's tz".
      // Approximation: format now in tz to get local Y-M-D, then use UTC offset diff.
      try {
        const local = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(day);
        const y = local.find((p) => p.type === "year")?.value;
        const m = local.find((p) => p.type === "month")?.value;
        const d = local.find((p) => p.type === "day")?.value;
        if (!y || !m || !d) continue;
        // Convert wall-clock local time to UTC via a probe date.
        const probe = new Date(`${y}-${m}-${d}T${String(h).padStart(2, "0")}:00:00Z`);
        const tzOffsetMinutes = (() => {
          const dtf = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hour12: false });
          const localHour = Number(dtf.format(probe));
          const utcHour = probe.getUTCHours();
          return (localHour - utcHour) * 60;
        })();
        const slotUtcMs = probe.getTime() - tzOffsetMinutes * 60_000;
        if (slotUtcMs > now.getTime() - 60_000) {
          out.push(new Date(slotUtcMs).toISOString());
          if (out.length >= count) break;
        }
      } catch { /* ignore */ }
    }
  }
  return out;
}

export const getAutopilotHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [settingsRes, recentRes, uploadedRes, notifRes, heartbeatRes, ytRes] = await Promise.all([
      context.supabase.from("autopilot_settings").select("*").eq("user_id", context.userId).maybeSingle(),
      context.supabase.from("videos")
        .select("id,title,status,error_message,autopilot_slot,youtube_video_id,created_at")
        .eq("user_id", context.userId)
        .not("autopilot_slot", "is", null)
        .order("created_at", { ascending: false })
        .limit(5),
      context.supabase.from("videos")
        .select("id,title,youtube_video_id,created_at")
        .eq("user_id", context.userId)
        .not("youtube_video_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      context.supabase.from("notifications")
        .select("title,message,created_at")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(5),
      context.supabase.from("autopilot_heartbeats").select("*").eq("source", "github").maybeSingle(),
      context.supabase.from("youtube_connections").select("scope,channel_title,updated_at").eq("user_id", context.userId).maybeSingle(),
    ]);

    const settings = settingsRes.data;
    const heartbeat = heartbeatRes.data;
    const heartbeatAgeMinutes = heartbeat?.last_ping
      ? Math.round((Date.now() - new Date(heartbeat.last_ping).getTime()) / 60_000)
      : null;

    const upcomingSlots = settings?.enabled
      ? computeUpcomingSlots(settings.slot_hours || [], settings.timezone || "UTC", 3)
      : [];

    const ytConnected = Boolean(ytRes.data && String(ytRes.data.scope || "").includes("youtube.upload"));

    return {
      settings,
      heartbeat: heartbeat
        ? { lastPing: heartbeat.last_ping, ageMinutes: heartbeatAgeMinutes, stale: (heartbeatAgeMinutes ?? 9999) > 130 }
        : { lastPing: null, ageMinutes: null, stale: true },
      upcomingSlots,
      recentRuns: recentRes.data ?? [],
      lastUpload: uploadedRes.data ?? null,
      notifications: notifRes.data ?? [],
      youtube: {
        connected: ytConnected,
        channelTitle: ytRes.data?.channel_title ?? null,
      },
    };
  });
