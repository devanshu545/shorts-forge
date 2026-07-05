import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  longVideoId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  progress: z.number().int().min(0).max(99),
  stage: z.string().min(1).max(220),
  workerId: z.string().max(160).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

async function handler(request: Request): Promise<Response> {
  try {
    const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
    if (!(await isAutopilotRequestAuthorized(request))) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = BodySchema.parse(await request.json());
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: job, error: readErr } = await supabaseAdmin
      .from("long_videos")
      .select("id,user_id")
      .eq("id", body.longVideoId)
      .maybeSingle();
    if (readErr) return Response.json({ ok: false, error: readErr.message }, { status: 500 });
    if (!job) return Response.json({ ok: false, error: "Long video job not found" }, { status: 404 });
    if (body.userId && body.userId !== job.user_id) {
      return Response.json({ ok: false, error: "Progress user mismatch" }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("long_videos")
      .update({
        status: "processing",
        progress_percent: body.progress,
        progress_stage: body.stage,
        last_progress_at: new Date().toISOString(),
        locked_by: body.workerId ?? undefined,
      } as never)
      .eq("id", body.longVideoId);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

    try {
      await supabaseAdmin.rpc("log_long_video_event" as never, {
        _long_video_id: body.longVideoId,
        _user_id: job.user_id,
        _event_type: "progress",
        _message: body.stage,
        _detail: { progress: body.progress, workerId: body.workerId, ...(body.detail ?? {}) },
      } as never);
    } catch { /* best-effort event log */ }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Progress update failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/splitter/progress")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});