import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const JobInput = z.object({
  name: z.string().min(2).max(120),
  niche: z.string().min(2).max(300),
  tone: z.string().min(2).max(80).default("energetic and punchy"),
  hookStyle: z.string().min(2).max(80).default("shocking statistic"),
  durationSeconds: z.number().int().min(15).max(90).default(45),
  nextRunAt: z.string().datetime(),
  cadence: z.enum(["once", "daily", "weekly"]).default("once"),
  autoUpload: z.boolean().default(false),
});

const ToggleInput = z.object({ id: z.string().uuid(), active: z.boolean() });
const DeleteInput = z.object({ id: z.string().uuid() });

export const listScheduledJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("scheduled_jobs")
      .select("*")
      .order("next_run_at", { ascending: true });
    if (error) throw new Error(error.message);
    return data;
  });

export const createScheduledJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => JobInput.parse(raw))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("scheduled_jobs")
      .insert({
        user_id: context.userId,
        name: data.name,
        niche: data.niche,
        tone: data.tone,
        hook_style: data.hookStyle,
        duration_seconds: data.durationSeconds,
        next_run_at: data.nextRunAt,
        cadence: data.cadence,
        auto_upload: data.autoUpload,
        active: true,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const toggleScheduledJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => ToggleInput.parse(raw))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("scheduled_jobs").update({ active: data.active }).eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteScheduledJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => DeleteInput.parse(raw))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("scheduled_jobs").delete().eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
