import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function nextRun(current: string, cadence: string) {
  const d = new Date(current);
  if (cadence === "daily") d.setDate(d.getDate() + 1);
  else if (cadence === "weekly") d.setDate(d.getDate() + 7);
  else if (cadence === "monthly") d.setMonth(d.getMonth() + 1);
  else return null;
  return d.toISOString();
}

serve(async (req) => {
  const secret = Deno.env.get("SCHEDULER_WORKER_SECRET");
  if (secret && req.headers.get("x-scheduler-secret") !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: jobs, error } = await supabase
    .from("scheduled_jobs")
    .select("*")
    .eq("active", true)
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(5);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "content-type": "application/json" } });

  const results = [];
  for (const job of jobs ?? []) {
    try {
      const { data: video, error: videoErr } = await supabase
        .from("videos")
        .insert({
          user_id: job.user_id,
          title: job.name,
          status: "queued",
          duration_seconds: job.duration_seconds,
          scheduled_for: job.next_run_at,
          generation_job_id: job.id,
          script: { scheduledInput: { niche: job.niche, tone: job.tone, hookStyle: job.hook_style, durationSeconds: job.duration_seconds } },
          generation_stage: "Scheduled job queued for generation",
        })
        .select("id")
        .single();
      if (videoErr) throw videoErr;
      await supabase.from("notifications").insert({ user_id: job.user_id, title: "Your Short has been queued!", message: `${job.name} reached its scheduled time and is queued in your library.` });
      const nr = nextRun(job.next_run_at, job.cadence);
      await supabase.from("scheduled_jobs").update({ last_run_at: new Date().toISOString(), next_run_at: nr || job.next_run_at, active: Boolean(nr) }).eq("id", job.id);
      results.push({ jobId: job.id, videoId: video.id, ok: true });
    } catch (err) {
      results.push({ jobId: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      await supabase.from("notifications").insert({ user_id: job.user_id, title: "Scheduled Short failed", message: err instanceof Error ? err.message : String(err) });
    }
  }
  return new Response(JSON.stringify({ processed: results.length, results }), { headers: { "content-type": "application/json" } });
});
