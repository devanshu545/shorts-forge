import { createFileRoute } from "@tanstack/react-router";

type UploadBody = {
  videoId: string;
  userId: string;
  mp4Base64: string;
  thumbnailBase64?: string;
  title: string;
  description: string;
  tags: string[];
  privacy: "public" | "unlisted" | "private";
  durationSeconds: number;
};

async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as UploadBody;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  try {
    const mp4 = new Uint8Array(Buffer.from(body.mp4Base64, "base64"));
    // Store MP4 in Supabase Storage
    const path = `${body.userId}/${body.videoId}/final.mp4`;
    const { error: upErr } = await supabaseAdmin.storage.from("videos").upload(path, mp4, { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);
    const { data: signed } = await supabaseAdmin.storage.from("videos").createSignedUrl(path, 60 * 60 * 24 * 7);

    // Thumbnail
    let thumbPath: string | null = null;
    let thumbUrl: string | null = null;
    if (body.thumbnailBase64) {
      const tbytes = new Uint8Array(Buffer.from(body.thumbnailBase64, "base64"));
      thumbPath = `${body.userId}/${body.videoId}.jpg`;
      await supabaseAdmin.storage.from("thumbnails").upload(thumbPath, tbytes, { contentType: "image/jpeg", upsert: true });
      const { data: ts } = await supabaseAdmin.storage.from("thumbnails").createSignedUrl(thumbPath, 60 * 60 * 24 * 7);
      thumbUrl = ts?.signedUrl ?? null;
    }

    await supabaseAdmin.from("videos").update({
      status: "ready",
      video_url: signed?.signedUrl ?? null,
      video_storage_path: path,
      file_size_bytes: mp4.byteLength,
      duration_seconds: Math.round(body.durationSeconds),
      generation_progress: 100,
      generation_stage: "Rendered. Uploading to YouTube...",
      thumbnail_url: thumbUrl,
      thumbnail_storage_path: thumbPath,
      error_message: null,
    } as never).eq("id", body.videoId);

    let ytId: string | null = null;
    let ytError: string | null = null;
    try {
      const { uploadExistingVideoToYouTube } = await import("@/lib/youtube-upload.server");
      const uploaded = await uploadExistingVideoToYouTube({
        supabaseAdmin,
        userId: body.userId,
        videoId: body.videoId,
        title: body.title,
        description: body.description,
        tags: body.tags,
        privacyStatus: body.privacy,
      });
      ytId = uploaded.youtubeVideoId;
    } catch (err) {
      ytError = err instanceof Error ? err.message : String(err);
      await supabaseAdmin.from("videos").update({
        status: "ready",
        generation_stage: "Rendered (YouTube upload failed)",
        error_message: ytError,
      } as never).eq("id", body.videoId);
    }

    await supabaseAdmin.from("notifications").insert({
      user_id: body.userId,
      title: ytId ? "Autopilot uploaded a Short 🚀" : "Autopilot rendered a Short (upload failed)",
      message: ytId ? `${body.title} — https://youtube.com/shorts/${ytId}` : (ytError || "Rendered but not uploaded"),
    } as never);

    return Response.json({ ok: true, youtubeId: ytId, error: ytError });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabaseAdmin.from("videos").update({ status: "failed", error_message: msg, generation_stage: "Autopilot failed" } as never).eq("id", body.videoId);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/autopilot/upload")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});
