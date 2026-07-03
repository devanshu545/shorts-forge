import { createFileRoute } from "@tanstack/react-router";

async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const clipId = new URL(request.url).searchParams.get("clipId");
  if (!clipId) return Response.json({ ok: false, error: "Missing clipId" }, { status: 400 });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: clip, error } = await supabaseAdmin
    .from("videos")
    .select("id,user_id,video_storage_path")
    .eq("id", clipId)
    .maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  if (!clip?.video_storage_path) return Response.json({ ok: true, job: null });

  const source = await supabaseAdmin.storage.from("videos").createSignedUrl(clip.video_storage_path, 60 * 60 * 2);
  if (source.error || !source.data) {
    return Response.json({ ok: false, error: source.error?.message || "Could not sign source clip" }, { status: 500 });
  }

  const upload = await supabaseAdmin.storage.from("videos").createSignedUploadUrl(clip.video_storage_path, { upsert: true });
  if (upload.error || !upload.data) {
    return Response.json({ ok: false, error: upload.error?.message || "Could not create 4K upload URL" }, { status: 500 });
  }

  await supabaseAdmin
    .from("videos")
    .update({ generation_stage: "Native 4K worker running", generation_progress: 15 } as never)
    .eq("id", clipId);

  return Response.json({
    ok: true,
    job: {
      clipId: clip.id,
      userId: clip.user_id,
      sourceUrl: source.data.signedUrl,
      uploadSignedUrl: upload.data.signedUrl,
    },
  });
}

export const Route = createFileRoute("/api/public/splitter/upscale-tick")({
  server: { handlers: { GET: async ({ request }) => handler(request), POST: async ({ request }) => handler(request) } },
});