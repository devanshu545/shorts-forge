import { createFileRoute, redirect } from "@tanstack/react-router";

async function handleCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const error_description = url.searchParams.get("error_description");

  if (error) {
    console.error("OAuth error from Google:", error, error_description);
    throw redirect({ to: "/channel", search: { error: error_description || error } as never });
  }
  if (!code || !state) {
    throw redirect({ to: "/channel", search: { error: "missing_code" } as never });
  }

  const userId = state.split(".")[0];
  if (!userId) {
    throw redirect({ to: "/channel", search: { error: "bad_state" } as never });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw redirect({ to: "/channel", search: { error: "not_configured" } as never });
  }

  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const redirectUri = `${proto}://${host}/api/public/youtube/callback`;

  // Exchange code for tokens
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tok = await tokRes.json();
  if (!tokRes.ok) {
    console.error("Token exchange failed:", tok);
    const msg = `Google token exchange failed ${tokRes.status}: ${tok.error_description || tok.error || JSON.stringify(tok)}`;
    throw redirect({ to: "/channel", search: { error: msg } as never });
  }

  // Fetch channel info
  const chRes = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,status,brandingSettings&mine=true",
    { headers: { Authorization: `Bearer ${tok.access_token}` } },
  );
  const chJson = await chRes.json();
  if (!chRes.ok) {
    console.error("Channel fetch failed:", chJson);
    const msg = `YouTube channel fetch failed ${chRes.status}: ${chJson.error?.message || JSON.stringify(chJson.error || chJson)}`;
    throw redirect({ to: "/channel", search: { error: msg } as never });
  }
  
  if (!chJson.items?.length) {
    console.error("No YouTube channel found for this account");
    throw redirect({ to: "/channel", search: { error: "no_youtube_channel_found" } as never });
  }
  
  const channel = chJson.items[0];

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: existing } = await supabaseAdmin
    .from("youtube_connections")
    .select("refresh_token")
    .eq("user_id", userId)
    .maybeSingle();
  const refreshToken = tok.refresh_token || existing?.refresh_token;
  if (!refreshToken) {
    throw redirect({
      to: "/channel",
      search: { error: "Google did not return a refresh token. Disconnect/revoke the app in your Google Account permissions, then connect again and accept all scopes." } as never,
    });
  }
  if (!String(tok.scope || "").includes("youtube.upload")) {
    throw redirect({
      to: "/channel",
      search: { error: "Google connected, but YouTube upload permission was not granted. Connect again and accept all requested YouTube scopes." } as never,
    });
  }
  const { error: dbErr } = await supabaseAdmin.from("youtube_connections").upsert(
    {
      user_id: userId,
      access_token: tok.access_token,
      refresh_token: refreshToken,
      token_expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      scope: tok.scope,
      channel_id: channel.id,
      channel_title: channel.snippet?.title ?? null,
      channel_thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || null,
      channel_description: channel.snippet?.description ?? null,
      channel_banner: channel.brandingSettings?.image?.bannerExternalUrl ?? null,
      channel_created_at: channel.snippet?.publishedAt ?? null,
      country: channel.snippet?.country ?? null,
      made_for_kids: channel.status?.madeForKids ?? null,
      statistics: channel.statistics ?? {},
      analytics: {},
    },
    { onConflict: "user_id" },
  );
  if (dbErr) {
    console.error("DB upsert failed:", dbErr);
    throw redirect({ to: "/channel", search: { error: "database_error" } as never });
  }

  throw redirect({ to: "/channel", search: { connected: "1" } as never });
}

export const Route = createFileRoute("/api/public/youtube/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => handleCallback(request),
    },
  },
});
