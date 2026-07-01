import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { getRequestHeader } from "@tanstack/react-start/server";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

function getOrigin(): string {
  const proto = getRequestHeader("x-forwarded-proto") ?? "https";
  const host = getRequestHeader("x-forwarded-host") ?? getRequestHeader("host");
  if (!host) throw new Error("Cannot determine host");
  return `${proto}://${host}`;
}

export const getYouTubeAuthUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) throw new Error("GOOGLE_OAUTH_CLIENT_ID not configured");

    const redirectUri = `${getOrigin()}/api/public/youtube/callback`;
    const state = `${context.userId}.${crypto.randomUUID()}`;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });

    return {
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      redirectUri,
    };
  });

export const getYouTubeConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("youtube_connections")
      .select("channel_id, channel_title, channel_thumbnail, connected_at, scope")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

export const disconnectYouTube = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("youtube_connections")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const RefreshInput = z.object({}).optional();
export const refreshChannelStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => RefreshInput.parse(raw))
  .handler(async ({ context }) => {
    const { data: conn } = await context.supabase
      .from("youtube_connections")
      .select("access_token, refresh_token, token_expires_at, channel_id")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!conn) throw new Error("No YouTube channel connected");

    let accessToken = conn.access_token;
    if (new Date(conn.token_expires_at).getTime() - Date.now() < 60_000) {
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: conn.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      const tok = await res.json();
      if (!res.ok) throw new Error(tok.error_description ?? "Token refresh failed");
      accessToken = tok.access_token;
      await context.supabase
        .from("youtube_connections")
        .update({
          access_token: accessToken,
          token_expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
        })
        .eq("user_id", context.userId);
    }

    const chRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${conn.channel_id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const chJson = await chRes.json();
    if (!chRes.ok) throw new Error(chJson.error?.message ?? "YouTube API error");
    const stats = chJson.items?.[0]?.statistics;
    if (!stats) throw new Error("No stats returned");

    await context.supabase.from("analytics_snapshots").insert({
      user_id: context.userId,
      source: "youtube",
      metrics: stats,
    });

    return { stats };
  });
