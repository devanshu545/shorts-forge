import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  longVideoId: z.string().uuid(),
  userId: z.string().uuid(),
  index: z.number().int().min(1).max(50),
});

async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: parent, error: parentErr } = await supabaseAdmin
    .from("long_videos")
    .select("id,user_id")
    .eq("id", body.longVideoId)
    .eq("user_id", body.userId)
    .maybeSingle();
  if (parentErr) return Response.json({ ok: false, error: parentErr.message }, { status: 500 });
  if (!parent) return Response.json({ ok: false, error: "Split job not found" }, { status: 404 });

  const clipId = crypto.randomUUID();
  const videoPath = `${body.userId}/${clipId}/clip.mp4`;
  const thumbnailPath = `${body.userId}/${clipId}.jpg`;
  const [videoSigned, thumbSigned] = await Promise.all([
    supabaseAdmin.storage.from("videos").createSignedUploadUrl(videoPath, { upsert: true }),
    supabaseAdmin.storage.from("thumbnails").createSignedUploadUrl(thumbnailPath, { upsert: true }),
  ]);
  if (videoSigned.error || !videoSigned.data?.signedUrl) {
    return Response.json({ ok: false, error: videoSigned.error?.message || "Could not prepare clip upload" }, { status: 500 });
  }
  if (thumbSigned.error || !thumbSigned.data?.signedUrl) {
    return Response.json({ ok: false, error: thumbSigned.error?.message || "Could not prepare thumbnail upload" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    clipId,
    videoPath,
    thumbnailPath,
    videoSignedUrl: videoSigned.data.signedUrl,
    thumbnailSignedUrl: thumbSigned.data.signedUrl,
  });
}

export const Route = createFileRoute("/api/public/splitter/prepare-clip-upload")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});