import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  videoId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  privacy: z.enum(["public", "unlisted", "private"]).default("public"),
}).default({ privacy: "public" });

async function parseBody(request: Request) {
  try {
    return BodySchema.parse(await request.json());
  } catch {
    return BodySchema.parse({});
  }
}

async function handler(request: Request): Promise<Response> {
  const secrets = [process.env.AUTOPILOT_SECRET, process.env.AUTOPILOT_SECRET_GITHUB].filter(Boolean);
  const url = new URL(request.url);
  const provided = request.headers.get("x-autopilot-secret") || url.searchParams.get("secret");
  if (!provided || !secrets.includes(provided)) {
    return Response.json({ ok: false, error: "Unauthorized: GitHub AUTOPILOT_SECRET does not match the app secret." }, { status: 401 });
  }

  const body = await parseBody(request);
  const requestedVideoId = url.searchParams.get("videoId") || body.videoId;
  const requestedUserId = url.searchParams.get("user") || body.userId;
  const privacy = (url.searchParams.get("privacy") || body.privacy) as "public" | "unlisted" | "private";
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  try {
    let target: { id: string; user_id: string; title: string | null } | null = null;

    if (requestedVideoId) {
      let query = supabaseAdmin
        .from("videos")
        .select("id,user_id,title,status,youtube_video_id,video_storage_path,video_url")
        .eq("id", requestedVideoId);
      if (requestedUserId) query = query.eq("user_id", requestedUserId);
      const { data, error } = await query.single();
      if (error || !data) throw new Error(error?.message || "Requested video was not found.");
      if (data.youtube_video_id) throw new Error(`This video is already uploaded: ${data.youtube_video_id}`);
      if (data.status !== "ready") throw new Error(`Requested video is not ready yet. Current status: ${data.status}`);
      if (!data.video_storage_path && !data.video_url) throw new Error("Requested video has no MP4 file saved yet.");
      target = data;
    } else {
      let query = supabaseAdmin
        .from("videos")
        .select("id,user_id,title,status,youtube_video_id,video_storage_path,video_url,created_at")
        .eq("status", "ready")
        .is("youtube_video_id", null)
        .order("created_at", { ascending: false })
        .limit(20);
      if (requestedUserId) query = query.eq("user_id", requestedUserId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      target = (data || []).find((video) => Boolean(video.video_storage_path || video.video_url)) ?? null;
      if (!target) throw new Error("No ready test video found. Click Test Flow in the app first, wait for the preview, then run GitHub workflow again.");
    }

    const { uploadExistingVideoToYouTube } = await import("@/lib/youtube-upload.server");
    const uploaded = await uploadExistingVideoToYouTube({
      supabaseAdmin,
      userId: target.user_id,
      videoId: target.id,
      privacyStatus: privacy,
    });

    await supabaseAdmin.from("notifications").insert({
      user_id: target.user_id,
      title: "GitHub workflow uploaded your test Short",
      message: `${target.title || "Short"} — ${uploaded.url}`,
    } as never);

    return Response.json({
      ok: true,
      mode: "manual-upload-existing-test-video",
      videoId: target.id,
      youtubeVideoId: uploaded.youtubeVideoId,
      youtubeUrl: uploaded.url,
      message: `Uploaded to YouTube! Video ID: ${uploaded.youtubeVideoId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/autopilot/run-workflow")({
  server: { handlers: { GET: async ({ request }) => handler(request), POST: async ({ request }) => handler(request) } },
});