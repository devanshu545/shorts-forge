import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  longVideoId: z.string().uuid(),
  status: z.enum(["ready", "failed", "failed_retryable", "failed_final"]),
  errorMessage: z.string().max(2000).optional(),
  durationSeconds: z.number().positive().optional(),
});

async function handler(request: Request): Promise<Response> {
  try {
    const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
    if (!(await isAutopilotRequestAuthorized(request))) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const body = BodySchema.parse(await request.json());
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("long_videos").select("user_id,original_filename,clips_generated").eq("id", body.longVideoId).maybeSingle();
    if (!row?.user_id) return Response.json({ ok: false, error: "Long video job not found" }, { status: 404 });

    const { count } = await supabaseAdmin
      .from("videos")
      .select("id", { count: "exact", head: true })
      .eq("long_video_id", body.longVideoId);
    const clipCount = count ?? row.clips_generated ?? 0;
    const finalStatus = body.status === "failed" ? "failed_retryable" : body.status;
    if (finalStatus === "ready" && clipCount < 1) {
      await supabaseAdmin.from("long_videos").update({
        status: "failed_retryable",
        error_message: "Worker finished without registering any clips. The job can be retried.",
        failure_code: "no_clips_registered",
        progress_stage: "Finished without clips",
        locked_at: null,
        locked_by: null,
      } as never).eq("id", body.longVideoId);
      return Response.json({ ok: false, error: "Cannot mark ready: no clips were registered" }, { status: 409 });
    }

    const patch: Record<string, unknown> = {
      status: finalStatus,
      error_message: finalStatus === "ready" ? null : (body.errorMessage ?? "Splitter failed"),
      failure_code: finalStatus === "ready" ? null : "worker_failed",
      clips_generated: clipCount,
      completed_at: finalStatus === "ready" ? new Date().toISOString() : null,
      progress_percent: finalStatus === "ready" ? 100 : 0,
      progress_stage: finalStatus === "ready" ? "All clips ready" : "Splitter failed",
      last_progress_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
    };
    if (body.durationSeconds) patch.duration_seconds = body.durationSeconds;
    await supabaseAdmin.from("long_videos").update(patch as never).eq("id", body.longVideoId);

    await supabaseAdmin.from("notifications").insert({
      user_id: row.user_id,
      title: finalStatus === "ready" ? "Long video split into Shorts 🎬" : "Splitter failed",
      message: finalStatus === "ready"
        ? `${row.original_filename || "Video"} → ${clipCount} clips ready in your library.`
        : (body.errorMessage || "Splitter failed"),
    } as never);

    try {
      await supabaseAdmin.rpc("log_long_video_event" as never, {
        _long_video_id: body.longVideoId,
        _user_id: row.user_id,
        _event_type: finalStatus === "ready" ? "completed" : "failed",
        _message: finalStatus === "ready" ? `Completed with ${clipCount} clips` : (body.errorMessage || "Splitter failed"),
        _detail: { clipCount, status: finalStatus },
      } as never);
    } catch { /* best-effort log */ }

    return Response.json({ ok: true, status: finalStatus, clipsGenerated: clipCount });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Splitter finish failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/splitter/finish")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});
