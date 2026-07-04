import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  longVideoId: z.string().uuid(),
  status: z.enum(["ready", "failed"]),
  errorMessage: z.string().max(2000).optional(),
  durationSeconds: z.number().positive().optional(),
});

async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const body = BodySchema.parse(await request.json());
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("long_videos").select("user_id,original_filename,clips_generated").eq("id", body.longVideoId).maybeSingle();

  const patch: Record<string, unknown> = {
    status: body.status,
    error_message: body.errorMessage ?? null,
  };
  if (body.durationSeconds) patch.duration_seconds = body.durationSeconds;
  await supabaseAdmin.from("long_videos").update(patch as never).eq("id", body.longVideoId);

  if (row?.user_id) {
    await supabaseAdmin.from("notifications").insert({
      user_id: row.user_id,
      title: body.status === "ready" ? "Long video split into Shorts 🎬" : "Splitter failed",
      message: body.status === "ready"
        ? `${row.original_filename || "Video"} → ${row.clips_generated ?? 0} clips ready in your library.`
        : (body.errorMessage || "Splitter failed"),
    } as never);
  }
  return Response.json({ ok: true });
}

export const Route = createFileRoute("/api/public/splitter/finish")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});
