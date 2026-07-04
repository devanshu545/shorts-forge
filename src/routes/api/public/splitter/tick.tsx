import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Splitter tick: GitHub Actions runner polls this to fetch the next queued
// long_video, then downloads the source, splits it, and POSTs back to
// /api/public/splitter/complete for each clip.
async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const explicitId = url.searchParams.get("longVideoId");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let q = supabaseAdmin
    .from("long_videos")
    .select("id,user_id,source_path,clip_length,max_clips,status")
    .or(`status.eq.queued,and(status.eq.processing,updated_at.lt.${new Date(Date.now() - 12 * 60 * 1000).toISOString()})`)
    .order("created_at", { ascending: true })
    .limit(1);
  if (explicitId) q = supabaseAdmin
    .from("long_videos")
    .select("id,user_id,source_path,clip_length,max_clips,status")
    .eq("id", explicitId)
    .limit(1);

  const { data: rows, error } = await q;
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const job = rows?.[0];
  if (!job) return Response.json({ ok: true, job: null });

  await supabaseAdmin.from("long_videos").update({ status: "processing", error_message: null } as never).eq("id", job.id);

  const { data: signed, error: signErr } = await supabaseAdmin
    .storage.from("videos").createSignedUrl(job.source_path, 60 * 60 * 2);
  if (signErr || !signed) {
    await supabaseAdmin.from("long_videos").update({ status: "failed", error_message: signErr?.message || "no signed URL" } as never).eq("id", job.id);
    return Response.json({ ok: false, error: signErr?.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    job: {
      longVideoId: job.id,
      userId: job.user_id,
      sourceUrl: signed.signedUrl,
      clipLength: job.clip_length,
      maxClips: job.max_clips,
    },
  });
}

export const Route = createFileRoute("/api/public/splitter/tick")({
  server: { handlers: { GET: async ({ request }) => handler(request), POST: async ({ request }) => handler(request) } },
});

// Also expose a helper subroute at /complete to upload one clip.
export const _bodySchema = z.object({
  longVideoId: z.string().uuid(),
  userId: z.string().uuid(),
  index: z.number().int().min(0),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  mp4Base64: z.string().min(100),
  thumbnailBase64: z.string().optional(),
  title: z.string().min(1).max(100),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
});
