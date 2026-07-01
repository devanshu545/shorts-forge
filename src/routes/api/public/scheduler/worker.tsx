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
      const { generateScheduledVideoForUser } = await import("@/lib/media.functions");
      const video = await generateScheduledVideoForUser({
        userId: job.user_id,
        niche: job.niche,
        tone: job.tone || "energetic and punchy",
        hookStyle: job.hook_style || "shocking statistic",
        durationSeconds: job.duration_seconds || 45,
        scheduledFor: job.next_run_at,
        generationJobId: job.id,
      });

      await supabaseAdmin.from("notifications").insert({
        user_id: job.user_id,
        title: "Your Short has been generated!",
        message: `${job.name} reached its scheduled time and was generated into your library.`,
      } as never);

      const nr = nextRun(job.next_run_at, job.cadence);
      await supabaseAdmin
        .from("scheduled_jobs")
        .update({ last_run_at: new Date().toISOString(), next_run_at: nr || job.next_run_at, active: Boolean(nr) } as never)
        .eq("id", job.id);
      results.push({ jobId: job.id, videoId: video.videoId, ok: true, warning: video.warning });
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
