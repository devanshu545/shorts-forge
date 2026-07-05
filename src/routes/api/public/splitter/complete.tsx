import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  longVideoId: z.string().uuid(),
  userId: z.string().uuid(),
  index: z.number().int().min(1).max(50),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  mp4Base64: z.string().min(100).optional(),
  thumbnailBase64: z.string().optional(),
  videoStoragePath: z.string().min(1).optional(),
  thumbnailStoragePath: z.string().min(1).optional(),
  fileSizeBytes: z.number().int().positive().optional(),
  title: z.string().min(1).max(100),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  durationSeconds: z.number().positive(),
}).refine((body) => Boolean(body.mp4Base64 || body.videoStoragePath), "Missing clip video payload");

async function handler(request: Request): Promise<Response> {
  try {
    const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
    if (!(await isAutopilotRequestAuthorized(request))) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = BodySchema.parse(await request.json());
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: parent, error: parentErr } = await supabaseAdmin
      .from("long_videos")
      .select("id,user_id,clips_generated")
      .eq("id", body.longVideoId)
      .eq("user_id", body.userId)
      .maybeSingle();
    if (parentErr) return Response.json({ ok: false, error: parentErr.message }, { status: 500 });
    if (!parent) return Response.json({ ok: false, error: "Long video job not found" }, { status: 404 });

    const { data: existing } = await supabaseAdmin
      .from("videos")
      .select("id,video_storage_path,thumbnail_storage_path")
      .eq("long_video_id", body.longVideoId)
      .eq("clip_index", body.index)
      .maybeSingle();

    const clipId = existing?.id || body.videoStoragePath?.split("/")[1] || crypto.randomUUID();
    let path = body.videoStoragePath || existing?.video_storage_path || `${body.userId}/${clipId}/clip.mp4`;
    let fileSizeBytes = body.fileSizeBytes ?? 0;
    if (!path.startsWith(`${body.userId}/`)) {
      return Response.json({ ok: false, error: "Invalid clip storage path" }, { status: 400 });
    }
    if (body.mp4Base64) {
      const mp4 = new Uint8Array(Buffer.from(body.mp4Base64, "base64"));
      fileSizeBytes = mp4.byteLength;
      const up = await supabaseAdmin.storage.from("videos").upload(path, mp4, { contentType: "video/mp4", upsert: true });
      if (up.error) return Response.json({ ok: false, error: up.error.message }, { status: 500 });
    }
    const signed = await supabaseAdmin.storage.from("videos").createSignedUrl(path, 60 * 60 * 24 * 30);
    if (signed.error || !signed.data?.signedUrl) {
      return Response.json({ ok: false, error: signed.error?.message || "Could not sign completed clip" }, { status: 500 });
    }

    let thumbUrl: string | null = null;
    let thumbPath: string | null = body.thumbnailStoragePath ?? existing?.thumbnail_storage_path ?? null;
    if (thumbPath && !thumbPath.startsWith(`${body.userId}/`)) {
      return Response.json({ ok: false, error: "Invalid thumbnail storage path" }, { status: 400 });
    }
    if (body.thumbnailBase64) {
      const tb = new Uint8Array(Buffer.from(body.thumbnailBase64, "base64"));
      thumbPath = thumbPath || `${body.userId}/${clipId}.jpg`;
      const thumbUp = await supabaseAdmin.storage.from("thumbnails").upload(thumbPath, tb, { contentType: "image/jpeg", upsert: true });
      if (thumbUp.error) return Response.json({ ok: false, error: thumbUp.error.message }, { status: 500 });
    }
    if (thumbPath) {
      const ts = await supabaseAdmin.storage.from("thumbnails").createSignedUrl(thumbPath, 60 * 60 * 24 * 30);
      thumbUrl = ts.data?.signedUrl ?? null;
    }

    const row = {
      id: clipId,
      user_id: body.userId,
      long_video_id: body.longVideoId,
      clip_index: body.index,
      title: body.title,
      description: body.description,
      tags: body.tags,
      hashtags: ["#shorts", "#shortsfeed"],
      status: "ready",
      video_url: signed.data.signedUrl,
      video_storage_path: path,
      thumbnail_url: thumbUrl,
      thumbnail_storage_path: thumbPath,
      duration_seconds: Math.round(body.durationSeconds),
      file_size_bytes: fileSizeBytes,
      clip_start_seconds: body.startSeconds,
      clip_end_seconds: body.endSeconds,
      generation_progress: 100,
      generation_stage: "Cinematic split · Shorts-safe 9:16",
      last_progress_at: new Date().toISOString(),
    };

    const write = existing
      ? await supabaseAdmin.from("videos").update(row as never).eq("id", existing.id)
      : await supabaseAdmin.from("videos").insert(row as never);
    if (write.error) return Response.json({ ok: false, error: write.error.message }, { status: 500 });

    const { count } = await supabaseAdmin
      .from("videos")
      .select("id", { count: "exact", head: true })
      .eq("long_video_id", body.longVideoId);
    await supabaseAdmin.from("long_videos").update({
      clips_generated: count ?? Math.max((parent.clips_generated as number | undefined) ?? 0, body.index),
      progress_percent: Math.min(95, 20 + Math.round(((count ?? body.index) / Math.max(1, body.index)) * 70)),
      progress_stage: `Uploaded clip ${body.index}`,
      last_progress_at: new Date().toISOString(),
    } as never).eq("id", body.longVideoId);

    try {
      await supabaseAdmin.rpc("log_long_video_event" as never, {
        _long_video_id: body.longVideoId,
        _user_id: body.userId,
        _event_type: existing ? "clip_updated" : "clip_created",
        _message: `Clip ${body.index} saved`,
        _detail: { clipId, path },
      } as never);
    } catch { /* best-effort event log */ }

    return Response.json({ ok: true, videoId: clipId, videoUrl: signed.data.signedUrl, updated: Boolean(existing) });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Clip completion failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/splitter/complete")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});
