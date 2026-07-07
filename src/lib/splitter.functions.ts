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
      .createSignedUploadUrl(path, { upsert: true });
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
      .update({ status: "processing", error_message: null } as never)
      .eq("id", data.longVideoId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const createClipUploadUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z.object({
      longVideoId: z.string().uuid(),
      clipIndex: z.number().int().min(1).max(50),
    }).parse(raw),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: parent, error: parentErr } = await supabaseAdmin
      .from("long_videos")
      .select("id,user_id")
      .eq("id", data.longVideoId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (parentErr) throw new Error(parentErr.message);
    if (!parent) throw new Error("Long video not found");

    const clipId = crypto.randomUUID();
    const videoPath = `${context.userId}/${clipId}/clip.mp4`;
    const thumbnailPath = `${context.userId}/${clipId}.jpg`;
    const [videoSigned, thumbSigned] = await Promise.all([
      supabaseAdmin.storage.from("videos").createSignedUploadUrl(videoPath, { upsert: true }),
      supabaseAdmin.storage.from("thumbnails").createSignedUploadUrl(thumbnailPath, { upsert: true }),
    ]);
    if (videoSigned.error || !videoSigned.data) throw new Error(videoSigned.error?.message || "Could not prepare clip upload");
    if (thumbSigned.error || !thumbSigned.data) throw new Error(thumbSigned.error?.message || "Could not prepare thumbnail upload");

    return {
      clipId,
      videoPath,
      thumbnailPath,
      videoSignedUrl: videoSigned.data.signedUrl,
      thumbnailSignedUrl: thumbSigned.data.signedUrl,
      videoToken: videoSigned.data.token,
      thumbnailToken: thumbSigned.data.token,
    };
  });

export const queueClip4KUpgrade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => z.object({ clipId: z.string().uuid() }).parse(raw))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: clip, error } = await supabaseAdmin
      .from("videos")
      .select("id,user_id,video_storage_path")
      .eq("id", data.clipId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!clip?.video_storage_path) throw new Error("Clip not found or missing storage path");

    await supabaseAdmin
      .from("videos")
      .update({ generation_stage: "Native 4K upgrade queued", generation_progress: 5 } as never)
      .eq("id", data.clipId)
      .eq("user_id", context.userId);

    const { triggerSplitterWorkflow } = await import("@/lib/github-dispatch.server");
    const dispatch = await triggerSplitterWorkflow({ clipId: data.clipId });
    if (!dispatch.ok) {
      await supabaseAdmin
        .from("videos")
        .update({ generation_stage: "4K queue failed", generation_progress: 0 } as never)
        .eq("id", data.clipId)
        .eq("user_id", context.userId);
      throw new Error(dispatch.message);
    }
    return { ok: true, latestRunUrl: dispatch.latestRunUrl ?? null };
  });

// Register a clip produced by the browser splitter. The browser has already
// uploaded the MP4 + thumbnail to Supabase Storage; this only inserts the row.
export const registerSplitClip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z.object({
      longVideoId: z.string().uuid(),
      clipId: z.string().uuid().optional(),
      videoStoragePath: z.string().min(1),
      thumbnailStoragePath: z.string().min(1).nullable(),
      title: z.string().min(1).max(100),
      description: z.string().default(""),
      tags: z.array(z.string()).default([]),
      hashtags: z.array(z.string()).default([]),
      startSeconds: z.number().nonnegative(),
      endSeconds: z.number().positive(),
      durationSeconds: z.number().positive(),
      fileSizeBytes: z.number().int().positive(),
    }).parse(raw),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const clipId = data.clipId ?? crypto.randomUUID();
    const videoSigned = await supabaseAdmin.storage.from("videos").createSignedUrl(data.videoStoragePath, 60 * 60 * 24 * 30);
    let thumbUrl: string | null = null;
    if (data.thumbnailStoragePath) {
      const t = await supabaseAdmin.storage.from("thumbnails").createSignedUrl(data.thumbnailStoragePath, 60 * 60 * 24 * 30);
      thumbUrl = t.data?.signedUrl ?? null;
    }
    const { error } = await supabaseAdmin.from("videos").insert({
      id: clipId,
      user_id: context.userId,
      long_video_id: data.longVideoId,
      title: data.title,
      description: data.description,
      tags: data.tags,
      hashtags: data.hashtags,
      status: "ready",
      video_url: videoSigned.data?.signedUrl ?? null,
      video_storage_path: data.videoStoragePath,
      thumbnail_url: thumbUrl,
      thumbnail_storage_path: data.thumbnailStoragePath,
      duration_seconds: Math.round(data.durationSeconds),
      file_size_bytes: data.fileSizeBytes,
      clip_start_seconds: data.startSeconds,
      clip_end_seconds: data.endSeconds,
      generation_progress: 100,
      generation_stage: "Split in your browser",
    } as never);
    if (error) throw new Error(error.message);

    const { data: parent } = await supabaseAdmin
      .from("long_videos").select("clips_generated").eq("id", data.longVideoId).maybeSingle();
    const nextCount = ((parent?.clips_generated as number | undefined) ?? 0) + 1;
    await supabaseAdmin.from("long_videos").update({ clips_generated: nextCount } as never).eq("id", data.longVideoId);

    return { videoId: clipId, videoUrl: videoSigned.data?.signedUrl ?? null };
  });

export const finishSplitJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z.object({
      longVideoId: z.string().uuid(),
      status: z.enum(["ready", "failed"]),
      durationSeconds: z.number().optional(),
      errorMessage: z.string().optional(),
    }).parse(raw),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch: Record<string, unknown> = { status: data.status };
    if (data.durationSeconds) patch.duration_seconds = Math.round(data.durationSeconds);
    if (data.errorMessage) patch.error_message = data.errorMessage.slice(0, 1000);
    const { error } = await supabaseAdmin
      .from("long_videos")
      .update(patch as never)
      .eq("id", data.longVideoId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
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
      .select("id,title,description,tags,hashtags,video_url,thumbnail_url,youtube_video_id,duration_seconds,clip_start_seconds,clip_end_seconds,status,generation_stage,generation_progress,created_at")
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
