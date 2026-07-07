import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  longVideoId: z.string().uuid(),
  userId: z.string().uuid(),
  index: z.number().int().min(0),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  mp4Base64: z.string().min(100),
  thumbnailBase64: z.string().optional(),
  title: z.string().min(1).max(100),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  durationSeconds: z.number().positive(),
});

async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const clipId = crypto.randomUUID();
  const mp4 = new Uint8Array(Buffer.from(body.mp4Base64, "base64"));
  const path = `${body.userId}/${clipId}/clip.mp4`;
  const up = await supabaseAdmin.storage.from("videos").upload(path, mp4, { contentType: "video/mp4", upsert: true });
  if (up.error) return Response.json({ ok: false, error: up.error.message }, { status: 500 });
  const signed = await supabaseAdmin.storage.from("videos").createSignedUrl(path, 60 * 60 * 24 * 30);

  let thumbUrl: string | null = null;
  let thumbPath: string | null = null;
  if (body.thumbnailBase64) {
    const tb = new Uint8Array(Buffer.from(body.thumbnailBase64, "base64"));
    thumbPath = `${body.userId}/${clipId}.jpg`;
    await supabaseAdmin.storage.from("thumbnails").upload(thumbPath, tb, { contentType: "image/jpeg", upsert: true });
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
    hashtags: [],
    status: "ready",
    video_url: signed.data?.signedUrl ?? null,
    video_storage_path: path,
    thumbnail_url: thumbUrl,
    thumbnail_storage_path: thumbPath,
    duration_seconds: Math.round(body.durationSeconds),
    file_size_bytes: mp4.byteLength,
    clip_start_seconds: body.startSeconds,
    clip_end_seconds: body.endSeconds,
    generation_progress: 100,
    generation_stage: "Split from long video",
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
