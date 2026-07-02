// Meta Graph API — Instagram Business Reels publish flow.
// Requires: IG Business account linked to a Facebook Page, plus a long-lived
// Page Access Token that has `instagram_basic`, `instagram_content_publish`,
// `pages_show_list`, `pages_read_engagement`.
//
// Reel publish is a 2-step flow:
//   1) POST /{ig-user-id}/media       { media_type: "REELS", video_url, caption }
//   2) Poll  /{creation-id}?fields=status_code    until FINISHED
//   3) POST /{ig-user-id}/media_publish { creation_id }
type SupabaseAdmin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

const GRAPH = "https://graph.facebook.com/v20.0";

type IgConnection = {
  ig_business_account_id: string;
  page_access_token: string;
  username: string | null;
};

async function getIgConnection(supabaseAdmin: SupabaseAdmin, userId: string): Promise<IgConnection> {
  const { data, error } = await supabaseAdmin
    .from("instagram_connections")
    .select("ig_business_account_id, page_access_token, username")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No Instagram account connected. Open the Instagram tab and connect first.");
  return data as IgConnection;
}

async function graphJson(path: string, init?: RequestInit) {
  const res = await fetch(`${GRAPH}${path}`, init);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Meta Graph non-JSON (${res.status}): ${text.slice(0, 300)}`); }
  if (!res.ok || json?.error) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const sub = json?.error?.error_user_msg ? ` — ${json.error.error_user_msg}` : "";
    throw new Error(`Meta Graph error: ${msg}${sub}`);
  }
  return json;
}

async function waitForContainer(creationId: string, token: string) {
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min max
  let last = "IN_PROGRESS";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const status = await graphJson(`/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    last = status.status_code || last;
    if (last === "FINISHED") return;
    if (last === "ERROR" || last === "EXPIRED") throw new Error(`Instagram container ${last}: ${status.status || "unknown"}`);
  }
  throw new Error(`Instagram container did not finish in time (last status: ${last})`);
}

type PublishArgs = {
  supabaseAdmin: SupabaseAdmin;
  userId: string;
  videoId: string;
  caption?: string | null;
  hashtags?: string[] | null;
};

function buildCaption(caption: string, hashtags: string[]): string {
  const tags = hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).slice(0, 30).join(" ");
  const body = (caption || "").trim();
  return [body, tags].filter(Boolean).join("\n\n").slice(0, 2200);
}

export async function publishExistingVideoToInstagram(args: PublishArgs) {
  const { supabaseAdmin, userId, videoId } = args;
  const conn = await getIgConnection(supabaseAdmin, userId);

  const { data: video, error } = await supabaseAdmin
    .from("videos")
    .select("id,user_id,title,description,hashtags,ig_caption,ig_hashtags,video_storage_path,video_url,instagram_media_id")
    .eq("id", videoId)
    .eq("user_id", userId)
    .single();
  if (error || !video) throw new Error(error?.message || "Video not found");
  if (video.instagram_media_id) throw new Error(`Already published on Instagram: ${video.instagram_media_id}`);

  // IG requires a publicly reachable URL. Storage-signed URLs work.
  let publicUrl = video.video_url as string | null;
  if (!publicUrl && video.video_storage_path) {
    const { data: signed, error: sErr } = await supabaseAdmin.storage
      .from("videos")
      .createSignedUrl(video.video_storage_path, 60 * 60);
    if (sErr || !signed?.signedUrl) throw new Error(`Could not sign video URL for Instagram: ${sErr?.message || "no url"}`);
    publicUrl = signed.signedUrl;
  }
  if (!publicUrl) throw new Error("No public MP4 URL to hand to Instagram.");

  const caption = buildCaption(
    args.caption ?? video.ig_caption ?? video.description ?? video.title ?? "",
    (args.hashtags && args.hashtags.length ? args.hashtags : (video.ig_hashtags as string[] | null) || (video.hashtags as string[] | null) || []) as string[],
  );

  // Step 1: create Reels container
  const create = await graphJson(`/${conn.ig_business_account_id}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: "REELS",
      video_url: publicUrl,
      caption,
      share_to_feed: true,
      access_token: conn.page_access_token,
    }),
  });
  const creationId = create.id as string;

  // Step 2: wait for FINISHED
  await waitForContainer(creationId, conn.page_access_token);

  // Step 3: publish
  const published = await graphJson(`/${conn.ig_business_account_id}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: creationId, access_token: conn.page_access_token }),
  });
  const mediaId = published.id as string;

  // Get permalink
  let permalink: string | null = null;
  try {
    const meta = await graphJson(`/${mediaId}?fields=permalink&access_token=${encodeURIComponent(conn.page_access_token)}`);
    permalink = meta.permalink ?? null;
  } catch { /* non-fatal */ }

  await supabaseAdmin.from("videos").update({
    instagram_media_id: mediaId,
    instagram_permalink: permalink,
    instagram_error: null,
    ig_caption: caption,
  } as never).eq("id", videoId).eq("user_id", userId);

  return { mediaId, permalink, username: conn.username };
}

export async function refreshInstagramStats(supabaseAdmin: SupabaseAdmin, userId: string) {
  const conn = await getIgConnection(supabaseAdmin, userId);
  const data = await graphJson(`/${conn.ig_business_account_id}?fields=username,followers_count,media_count&access_token=${encodeURIComponent(conn.page_access_token)}`);
  await supabaseAdmin.from("instagram_connections").update({
    username: data.username ?? conn.username,
    followers_count: data.followers_count ?? 0,
    media_count: data.media_count ?? 0,
  } as never).eq("user_id", userId);
  return data;
}
