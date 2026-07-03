import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const BodySchema = z.object({
  clipId: z.string().uuid(),
  progress: z.number().int().min(1).max(99),
  stage: z.string().min(1).max(180),
});

async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = BodySchema.parse(await request.json());
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("videos")
    .update({ generation_stage: body.stage, generation_progress: body.progress } as never)
    .eq("id", body.clipId);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

export const Route = createFileRoute("/api/public/splitter/upscale-progress")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});