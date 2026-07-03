import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Ask for a signed upload URL against the "videos" bucket at long-source/<userId>/<uuid>.mp4
export const createLongVideoUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z.object({
      filename: z.string().min(1).max(200),
      sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024), // 2GB cap
      clipLength: z.number().int().min(15).max(60).default(55),
      maxClips: z.number().int().min(1).max(15).default(5),
    }).parse(raw),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const id = crypto.randomUUID();
    const safeExt = (data.filename.match(/\.([a-zA-Z0-9]{1,5})$/)?.[1] || "mp4").toLowerCase();
    const path = `long-source/${context.userId}/${id}.${safeExt}`;

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from("videos")
      .createSignedUploadUrl(path);
    if (signErr || !signed) throw new Error(signErr?.message || "Could not create upload URL");

    const { data: row, error: insErr } = await supabaseAdmin
      .from("long_videos")
      .insert({
        id,
        user_id: context.userId,
        source_path: path,
        original_filename: data.filename,
        size_bytes: data.sizeBytes,
        clip_length: data.clipLength,
        max_clips: data.maxClips,
        status: "uploading",
      } as never)
      .select("*")
      .single();
    if (insErr) throw new Error(insErr.message);

    return {
      longVideoId: (row as { id: string }).id,
      path,
      token: signed.token,
      signedUrl: signed.signedUrl,
    };
  });

export const markLongVideoQueued = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => z.object({ longVideoId: z.string().uuid() }).parse(raw))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("long_videos")
      .update({ status: "queued" } as never)
      .eq("id", data.longVideoId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);

    // Kick off GitHub Actions splitter worker immediately.
    try {
      const { triggerSplitterWorkflow } = await import("@/lib/github-dispatch.server");
      await triggerSplitterWorkflow({ longVideoId: data.longVideoId });
    } catch (err) {
      console.warn("Splitter dispatch failed", err);
    }
    return { ok: true };
  });

export const listLongVideos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("long_videos")
      .select("id,original_filename,duration_seconds,clip_length,max_clips,status,error_message,clips_generated,created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listClipsForLongVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => z.object({ longVideoId: z.string().uuid() }).parse(raw))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("videos")
      .select("id,title,description,tags,hashtags,video_url,thumbnail_url,youtube_video_id,duration_seconds,clip_start_seconds,clip_end_seconds,status,created_at")
      .eq("user_id", context.userId)
      .eq("long_video_id", data.longVideoId)
      .order("clip_start_seconds", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const deleteLongVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => z.object({ longVideoId: z.string().uuid() }).parse(raw))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("long_videos")
      .select("source_path,user_id")
      .eq("id", data.longVideoId)
      .maybeSingle();
    if (row && row.user_id === context.userId) {
      try { await supabaseAdmin.storage.from("videos").remove([row.source_path]); } catch {}
    }
    const { error } = await supabaseAdmin
      .from("long_videos")
      .delete()
      .eq("id", data.longVideoId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
