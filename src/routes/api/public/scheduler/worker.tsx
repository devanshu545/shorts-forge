import { createFileRoute } from "@tanstack/react-router";

function nextRun(current: string, cadence: string) {
  const d = new Date(current);
  if (cadence === "daily") d.setDate(d.getDate() + 1);
  else if (cadence === "weekly") d.setDate(d.getDate() + 7);
  else if (cadence === "monthly") d.setMonth(d.getMonth() + 1);
  else return null;
  return d.toISOString();
}

async function handler(request: Request): Promise<Response> {
  const expected = process.env.SCHEDULER_WORKER_SECRET;
  const provided = request.headers.get("x-scheduler-secret") || new URL(request.url).searchParams.get("secret");
  if (expected && provided !== expected) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: jobs, error } = await supabaseAdmin
    .from("scheduled_jobs")
    .select("*")
    .eq("active", true)
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(5);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: unknown[] = [];
  for (const job of jobs || []) {
    try {
      const { data: video, error: videoErr } = await supabaseAdmin
        .from("videos")
        .insert({
          user_id: job.user_id,
          title: job.name,
          status: "queued",
          duration_seconds: job.duration_seconds,
          scheduled_for: job.next_run_at,
          generation_job_id: job.id,
          script: {
            scheduledInput: {
              niche: job.niche,
              tone: job.tone,
              hookStyle: job.hook_style,
              durationSeconds: job.duration_seconds,
            },
          },
          generation_stage: "Scheduled job queued for generation",
        } as never)
        .select("id")
        .single();
      if (videoErr) throw videoErr;

      await supabaseAdmin.from("notifications").insert({
        user_id: job.user_id,
        title: "Your Short has been queued!",
        message: `${job.name} reached its scheduled time and is queued in your library. Open it and click Regenerate/Generate video to spend Veo credits when ready.`,
      } as never);

      const nr = nextRun(job.next_run_at, job.cadence);
      await supabaseAdmin
        .from("scheduled_jobs")
        .update({ last_run_at: new Date().toISOString(), next_run_at: nr || job.next_run_at, active: Boolean(nr) } as never)
        .eq("id", job.id);
      results.push({ jobId: job.id, videoId: video.id, ok: true });
    } catch (err) {
      results.push({ jobId: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      await supabaseAdmin.from("notifications").insert({
        user_id: job.user_id,
        title: "Scheduled Short failed",
        message: err instanceof Error ? err.message : String(err),
      } as never);
    }
  }

  return Response.json({ processed: results.length, results });
}

export const Route = createFileRoute("/api/public/scheduler/worker")({
  server: { handlers: { GET: async ({ request }) => handler(request), POST: async ({ request }) => handler(request) } },
});
