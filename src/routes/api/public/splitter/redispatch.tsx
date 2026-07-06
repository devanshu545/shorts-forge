import { createFileRoute } from "@tanstack/react-router";

// pg_cron hits this every couple of minutes. It looks for long_videos that
// have been queued/uploaded/failed_retryable without progress for too long,
// resets their attempt counter, and re-triggers the GitHub Actions splitter
// workflow so a runner is guaranteed to pick them up.
async function handler(request: Request): Promise<Response> {
  try {
    const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
    // Also allow the Supabase anon key via apikey header (pg_cron pattern).
    const anonKey = request.headers.get("apikey");
    const anonOk = anonKey && (anonKey === process.env.SUPABASE_ANON_KEY || anonKey === process.env.SUPABASE_PUBLISHABLE_KEY);
    if (!anonOk && !(await isAutopilotRequestAuthorized(request))) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Recover any stale processing jobs first.
    try { await supabaseAdmin.rpc("mark_stale_long_video_jobs" as never, {} as never); } catch { /* best-effort */ }

    // Find jobs stuck waiting for a worker (uploaded/queued/failed_retryable,
    // not locked, older than 2 minutes since last update).
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuck, error } = await supabaseAdmin
      .from("long_videos")
      .select("id,status,attempt_count,updated_at")
      .in("status", ["uploaded", "queued", "failed_retryable"])
      .is("locked_by", null)
      .lt("updated_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(5);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

    const results: Array<{ id: string; dispatched: boolean; message?: string }> = [];
    if (stuck && stuck.length > 0) {
      const { triggerSplitterWorkflow } = await import("@/lib/github-dispatch.server");
      for (const job of stuck) {
        // Reset attempt count so claim_next_long_video_job (max 3 attempts) will pick it up again.
        await supabaseAdmin.from("long_videos").update({
          status: "queued",
          attempt_count: 0,
          error_message: null,
          failure_code: null,
          progress_stage: "Re-queued by scheduler",
          last_progress_at: new Date().toISOString(),
        } as never).eq("id", (job as { id: string }).id);
        try {
          const dispatch = await triggerSplitterWorkflow({ longVideoId: (job as { id: string }).id });
          results.push({ id: (job as { id: string }).id, dispatched: dispatch.ok, message: dispatch.message });
        } catch (err) {
          results.push({ id: (job as { id: string }).id, dispatched: false, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return Response.json({ ok: true, recovered: results.length, results });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Redispatch failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/splitter/redispatch")({
  server: { handlers: { GET: async ({ request }) => handler(request), POST: async ({ request }) => handler(request) } },
});
