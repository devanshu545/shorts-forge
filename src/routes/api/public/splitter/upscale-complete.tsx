import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  clipId: z.string().uuid(),
  fileSizeBytes: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  errorMessage: z.string().max(2000).optional(),
});

async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: clip, error } = await supabaseAdmin
    .from("videos")
    .select("id,user_id,video_storage_path,title")
    .eq("id", body.clipId)
    .maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  if (!clip?.video_storage_path) return Response.json({ ok: false, error: "Clip not found" }, { status: 404 });

  if (body.errorMessage) {
    await supabaseAdmin
      .from("videos")
      .update({ generation_stage: `4K failed: ${body.errorMessage.slice(0, 180)}`, generation_progress: 0 } as never)
      .eq("id", body.clipId);
    return Response.json({ ok: true });
  }

  const signed = await supabaseAdmin.storage.from("videos").createSignedUrl(clip.video_storage_path, 60 * 60 * 24 * 30);
  const patch: Record<string, unknown> = {
    video_url: signed.data?.signedUrl ?? null,
    generation_stage: "Native 4K upgrade ready",
    generation_progress: 100,
  };
  if (body.fileSizeBytes) patch.file_size_bytes = body.fileSizeBytes;
  if (body.durationSeconds) patch.duration_seconds = Math.round(body.durationSeconds);

  await supabaseAdmin.from("videos").update(patch as never).eq("id", body.clipId);
  await supabaseAdmin.from("notifications").insert({
    user_id: clip.user_id,
    title: "4K Short ready",
    message: `${clip.title || "Your short"} has been upgraded with the native 4K renderer.`,
  } as never);

  return Response.json({ ok: true, videoUrl: signed.data?.signedUrl ?? null });
}

export const Route = createFileRoute("/api/public/splitter/upscale-complete")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});