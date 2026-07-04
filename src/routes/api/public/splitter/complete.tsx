import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  longVideoId: z.string().uuid(),
  userId: z.string().uuid(),
  index: z.number().int().min(0),
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
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const clipId = body.videoStoragePath?.split("/")[1] || crypto.randomUUID();
  let path = body.videoStoragePath || `${body.userId}/${clipId}/clip.mp4`;
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

  let thumbUrl: string | null = null;
  let thumbPath: string | null = body.thumbnailStoragePath ?? null;
  if (thumbPath && !thumbPath.startsWith(`${body.userId}/`)) {
    return Response.json({ ok: false, error: "Invalid thumbnail storage path" }, { status: 400 });
  }
  if (body.thumbnailBase64) {
    const tb = new Uint8Array(Buffer.from(body.thumbnailBase64, "base64"));
    thumbPath = thumbPath || `${body.userId}/${clipId}.jpg`;
    await supabaseAdmin.storage.from("thumbnails").upload(thumbPath, tb, { contentType: "image/jpeg", upsert: true });
  }
  if (thumbPath) {
    const ts = await supabaseAdmin.storage.from("thumbnails").createSignedUrl(thumbPath, 60 * 60 * 24 * 30);
    thumbUrl = ts.data?.signedUrl ?? null;
  }

  const { error: insErr } = await supabaseAdmin.from("videos").insert({
    id: clipId,
    user_id: body.userId,
    long_video_id: body.longVideoId,
    title: body.title,
    description: body.description,
    tags: body.tags,
    hashtags: ["#shorts", "#shortsfeed"],
    status: "ready",
    video_url: signed.data?.signedUrl ?? null,
    video_storage_path: path,
    thumbnail_url: thumbUrl,
    thumbnail_storage_path: thumbPath,
    duration_seconds: Math.round(body.durationSeconds),
    file_size_bytes: fileSizeBytes,
    clip_start_seconds: body.startSeconds,
    clip_end_seconds: body.endSeconds,
    generation_progress: 100,
    generation_stage: "Cinematic split · Shorts-safe 9:16",
  } as never);
  if (insErr) return Response.json({ ok: false, error: insErr.message }, { status: 500 });

  // Increment counter on the long_videos row.
  const { data: parent } = await supabaseAdmin
    .from("long_videos").select("clips_generated").eq("id", body.longVideoId).maybeSingle();
  const nextCount = ((parent?.clips_generated as number | undefined) ?? 0) + 1;
  await supabaseAdmin.from("long_videos").update({ clips_generated: nextCount } as never).eq("id", body.longVideoId);

  return Response.json({ ok: true, videoId: clipId, videoUrl: signed.data?.signedUrl ?? null });
}

export const Route = createFileRoute("/api/public/splitter/complete")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});
