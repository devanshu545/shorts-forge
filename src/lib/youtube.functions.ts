import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { getRequestHeader } from "@tanstack/react-start/server";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
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
    const state = `${context.userId}.${Math.random().toString(36).substring(2)}`;

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
      .select("channel_id, channel_title, channel_thumbnail, channel_description, channel_banner, channel_created_at, country, made_for_kids, connected_at, scope, statistics, analytics")
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
      .select("access_token, refresh_token, token_expires_at, channel_id, scope")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!conn) throw new Error("No YouTube channel connected");

    let accessToken = conn.access_token;
    // Refresh token if expiring in less than 5 minutes
    if (new Date(conn.token_expires_at).getTime() - Date.now() < 300_000) {
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
      if (!res.ok) throw new Error(`Token refresh failed: ${tok.error_description || tok.error || "Unknown error"}`);
      accessToken = tok.access_token;
      await context.supabase
        .from("youtube_connections")
        .update({
          access_token: accessToken,
          token_expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
        })
        .eq("user_id", context.userId);
    }

    // 1. Fetch lifetime/channel details from YouTube Data API
    const chRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,status,brandingSettings&id=${conn.channel_id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const chJson = await chRes.json();
    if (!chRes.ok) {
      throw new Error(`YouTube Data API Error ${chRes.status}: ${chJson.error?.message || JSON.stringify(chJson.error || chJson)}`);
    }
    const channel = chJson.items?.[0];
    const lifetimeStats = channel?.statistics;
    if (!lifetimeStats) throw new Error("No lifetime stats returned from YouTube");

    // 2. Fetch recent analytics (last 30 days) from YouTube Analytics API
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    
    const analyticsUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${startDate}&endDate=${endDate}&metrics=views,comments,likes,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost`;
    const analyticsRes = await fetch(
      analyticsUrl,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    
    const analyticsJson = await analyticsRes.json();
    let analyticsData: Record<string, unknown> | null = null;
    
    if (analyticsRes.ok && analyticsJson.rows?.[0]) {
      // Map columns to values
      const mappedAnalytics: Record<string, unknown> = {};
      analyticsJson.columnHeaders.forEach((header: any, index: number) => {
        mappedAnalytics[header.name] = analyticsJson.rows[0][index];
      });
      analyticsData = mappedAnalytics;
    } else if (!analyticsRes.ok) {
      analyticsData = {
        error: `YouTube Analytics API Error ${analyticsRes.status}: ${analyticsJson.error?.message || JSON.stringify(analyticsJson.error || analyticsJson)}`,
      };
    }

    const topVideosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${encodeURIComponent(conn.channel_id!)}&maxResults=10&order=viewCount&type=video`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const topVideosJson = await topVideosRes.json();
    let topVideos: unknown[] = [];
    if (topVideosRes.ok && topVideosJson.items?.length) {
      const ids = topVideosJson.items.map((item: any) => item.id?.videoId).filter(Boolean).join(",");
      if (ids) {
        const detailRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const detailJson = await detailRes.json();
        if (detailRes.ok) {
          topVideos = (detailJson.items || []).map((item: any) => ({
            id: item.id,
            title: item.snippet?.title,
            views: item.statistics?.viewCount,
            likes: item.statistics?.likeCount,
            comments: item.statistics?.commentCount,
          }));
        }
      }
    }

    const channelAgeMs = channel.snippet?.publishedAt ? Date.now() - new Date(channel.snippet.publishedAt).getTime() : null;
    const channelAgeMonths = channelAgeMs ? Math.floor(channelAgeMs / (1000 * 60 * 60 * 24 * 30.4375)) : null;

    const metrics = {
      ...lifetimeStats,
      channelTitle: channel.snippet?.title,
      channelDescription: channel.snippet?.description,
      thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url,
      banner: channel.brandingSettings?.image?.bannerExternalUrl,
      publishedAt: channel.snippet?.publishedAt,
      country: channel.snippet?.country,
      madeForKids: channel.status?.madeForKids,
      channelAgeMonths,
      watchHours28Days: analyticsData?.estimatedMinutesWatched ? Number(analyticsData.estimatedMinutesWatched) / 60 : null,
      topVideos,
      analyticsError: analyticsData?.error,
      recent: analyticsData,
      fetched_at: new Date().toISOString()
    };

    await context.supabase.from("youtube_connections").update({
      channel_title: channel.snippet?.title ?? null,
      channel_thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || null,
      channel_description: channel.snippet?.description ?? null,
      channel_banner: channel.brandingSettings?.image?.bannerExternalUrl ?? null,
      channel_created_at: channel.snippet?.publishedAt ?? null,
      country: channel.snippet?.country ?? null,
      made_for_kids: channel.status?.madeForKids ?? null,
      statistics: lifetimeStats,
      analytics: metrics,
    }).eq("user_id", context.userId);

    await context.supabase.from("analytics_snapshots").insert({
      user_id: context.userId,
      source: "youtube",
      metrics: metrics,
    });

    return { stats: metrics };
  });

export const syncYouTubeUploadState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getFreshYouTubeAccessToken } = await import("@/lib/youtube-upload.server");
    const { data: uploaded, error } = await context.supabase
      .from("videos")
      .select("id,youtube_video_id")
      .eq("user_id", context.userId)
      .not("youtube_video_id", "is", null)
      .limit(200);
    if (error) throw new Error(error.message);
    const ids = (uploaded ?? [])
      .map((row) => row.youtube_video_id)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return { checked: 0, missing: 0 };

    const accessToken = await getFreshYouTubeAccessToken(supabaseAdmin, context.userId);
    const existing = new Set<string>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&id=${chunk.map(encodeURIComponent).join(",")}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`YouTube sync failed: ${body.error?.message || JSON.stringify(body.error || body)}`);
      for (const item of body.items ?? []) if (item.id) existing.add(item.id);
    }

    const missing = ids.filter((id) => !existing.has(id));
    if (missing.length) {
      const { error: updErr } = await supabaseAdmin
        .from("videos")
        .update({
          youtube_video_id: null,
          status: "ready",
          uploaded_at: null,
          generation_stage: "YouTube Short removed — ready to re-upload",
        } as never)
        .eq("user_id", context.userId)
        .in("youtube_video_id", missing);
      if (updErr) throw new Error(updErr.message);
    }
    return { checked: ids.length, missing: missing.length };
  });
