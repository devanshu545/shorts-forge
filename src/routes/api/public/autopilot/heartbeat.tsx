import { createFileRoute } from "@tanstack/react-router";

async function handler(request: Request): Promise<Response> {
  const { isAutopilotRequestAuthorized } = await import("@/lib/autopilot-auth.server");
  if (!(await isAutopilotRequestAuthorized(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let detail: unknown = null;
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      detail = await request.json();
    }
  } catch {}

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const source = new URL(request.url).searchParams.get("source") || "github";
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("autopilot_heartbeats")
    .upsert(
      { source, last_ping: now, updated_at: now, detail: (detail as never) ?? null } as never,
      { onConflict: "source" },
    );
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  return Response.json({ ok: true, source, lastPing: now });
}

export const Route = createFileRoute("/api/public/autopilot/heartbeat")({
  server: {
    handlers: {
      GET: async ({ request }) => handler(request),
      POST: async ({ request }) => handler(request),
    },
  },
});
