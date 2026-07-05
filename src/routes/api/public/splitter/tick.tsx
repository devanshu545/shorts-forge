import { createFileRoute } from "@tanstack/react-router";

// Splitter tick: GitHub Actions runner polls this to fetch the next queued
// long_video, then downloads the source, splits it, and POSTs back to
// /api/public/splitter/complete for each clip.
function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function handler(request: Request): Promise<Response> {
  try {
    const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
    if (!(await isAutopilotRequestAuthorized(request))) {
      return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const explicitId = url.searchParams.get("longVideoId");
    const workerId = request.headers.get("x-worker-run-id") || url.searchParams.get("worker") || `worker-${crypto.randomUUID()}`;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    await supabaseAdmin.rpc("mark_stale_long_video_jobs" as never, {} as never).catch(() => null);
    const { data: rows, error } = await supabaseAdmin.rpc("claim_next_long_video_job" as never, {
      _worker_id: workerId,
      _explicit_id: explicitId,
      _stale_after: "00:15:00",
      _max_attempts: 3,
    } as never);
    if (error) return json({ ok: false, error: error.message }, { status: 500 });
    const job = Array.isArray(rows) ? rows[0] as any : null;
    if (!job) return json({ ok: true, job: null });

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage.from("videos").createSignedUrl(job.source_path, 60 * 60 * 2);
    if (signErr || !signed) {
      await supabaseAdmin.from("long_videos").update({
        status: "failed_retryable",
        failure_code: "source_sign_failed",
        error_message: signErr?.message || "Could not sign source video",
        progress_stage: "Could not prepare source download",
        locked_at: null,
        locked_by: null,
      } as never).eq("id", job.id);
      return json({ ok: false, error: signErr?.message || "Could not sign source video" }, { status: 500 });
    }

    await supabaseAdmin.rpc("log_long_video_event" as never, {
      _long_video_id: job.id,
      _user_id: job.user_id,
      _event_type: "claimed",
      _message: "Native splitter worker claimed the job",
      _detail: { workerId, attempt: job.attempt_count },
    } as never).catch(() => null);

    return json({
      ok: true,
      job: {
        longVideoId: job.id,
        userId: job.user_id,
        sourceUrl: signed.signedUrl,
        clipLength: job.clip_length,
        maxClips: job.max_clips,
        workerId,
        attempt: job.attempt_count,
      },
    });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : "Splitter tick failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/splitter/tick")({
  server: { handlers: { GET: async ({ request }) => handler(request), POST: async ({ request }) => handler(request) } },
});
