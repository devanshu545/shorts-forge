type SupabaseAdmin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

export type YouTubePrivacy = "public" | "unlisted" | "private";

type UploadMeta = {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: YouTubePrivacy;
};

type UploadExistingVideoArgs = {
  supabaseAdmin: SupabaseAdmin;
  userId: string;
  videoId: string;
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  privacyStatus?: YouTubePrivacy;
};

function asArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function googleError(body: string) {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; errors?: unknown[] } };
    return parsed.error?.message || JSON.stringify(parsed.error || parsed).slice(0, 600);
  } catch {
    return body.slice(0, 600);
  }
}

async function refreshAccessToken(supabaseAdmin: SupabaseAdmin, userId: string, refreshToken: string) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth client secrets are not configured");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${tok.error_description || tok.error || JSON.stringify(tok)}`);

  await supabaseAdmin
    .from("youtube_connections")
    .update({ access_token: tok.access_token, token_expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString() } as never)
    .eq("user_id", userId);

  return tok.access_token as string;
}

export async function getFreshYouTubeAccessToken(supabaseAdmin: SupabaseAdmin, userId: string) {
  const { data: conn, error } = await supabaseAdmin
    .from("youtube_connections")
    .select("access_token, refresh_token, token_expires_at, scope")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!conn) throw new Error("No YouTube channel connected. Connect YouTube first in the Channel tab.");
  if (!conn.refresh_token) throw new Error("Reconnect YouTube: saved refresh token is missing.");
  if (!String(conn.scope || "").includes("youtube.upload")) {
    throw new Error("Reconnect YouTube: upload permission is missing from the saved Google token.");
  }

  if (new Date(conn.token_expires_at).getTime() - Date.now() < 300_000) {
    return refreshAccessToken(supabaseAdmin, userId, conn.refresh_token);
  }

  return conn.access_token as string;
}

export async function uploadMp4ToYouTube(accessToken: string, bytes: ArrayBuffer | Uint8Array, meta: UploadMeta) {
  const file = asArrayBuffer(bytes);
  const initRes = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(file.byteLength),
    },
    body: JSON.stringify({
      snippet: {
        title: meta.title.slice(0, 100),
        description: meta.description.slice(0, 5000),
        tags: meta.tags.slice(0, 30),
        categoryId: "24",
      },
      status: { privacyStatus: meta.privacyStatus, selfDeclaredMadeForKids: false },
    }),
  });
  const initText = await initRes.text();
  if (!initRes.ok) throw new Error(`YouTube upload init failed: HTTP ${initRes.status} ${googleError(initText)}`);
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube upload init failed: missing resumable upload URL");

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(file.byteLength) },
    body: file,
  });
  const uploadText = await uploadRes.text();
  const uploadJson = uploadText ? JSON.parse(uploadText) : {};
  if (!uploadRes.ok) throw new Error(`YouTube upload failed: HTTP ${uploadRes.status} ${googleError(uploadText)}`);
  if (!uploadJson.id) throw new Error(`YouTube upload succeeded but no video id returned: ${uploadText.slice(0, 600)}`);
  return uploadJson.id as string;
}

async function uploadThumbnailIfPresent(supabaseAdmin: SupabaseAdmin, accessToken: string, youtubeId: string, thumbnailStoragePath: string | null) {
  if (!thumbnailStoragePath) return;
  try {
    const { data: thumb } = await supabaseAdmin.storage.from("thumbnails").download(thumbnailStoragePath);
    if (!thumb) return;
    await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(youtubeId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": thumb.type || "image/png" },
      body: await thumb.arrayBuffer(),
    });
  } catch (err) {
    console.warn("Thumbnail upload failed", err);
  }
}

export async function uploadExistingVideoToYouTube(args: UploadExistingVideoArgs) {
  const { supabaseAdmin, userId, videoId } = args;
  const { data: video, error } = await supabaseAdmin
    .from("videos")
    .select("id,user_id,title,description,tags,video_storage_path,thumbnail_storage_path,video_url")
    .eq("id", videoId)
    .eq("user_id", userId)
    .single();

  if (error || !video) throw new Error(error?.message || "Video not found");
  if (!video.video_storage_path && !video.video_url) throw new Error("No MP4 file is attached to this library item");

  let bytes: ArrayBuffer;
  if (video.video_storage_path) {
    const { data: blob, error: downErr } = await supabaseAdmin.storage.from("videos").download(video.video_storage_path);
    if (downErr || !blob) throw new Error(`Could not read video from storage: ${downErr?.message || "missing file"}`);
    bytes = await blob.arrayBuffer();
  } else {
    const res = await fetch(video.video_url!);
    if (!res.ok) throw new Error(`Could not fetch video URL: HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
  }

  const meta: UploadMeta = {
    title: (args.title || video.title || "New Short").slice(0, 100),
    description: args.description ?? video.description ?? "",
    tags: (args.tags?.length ? args.tags : (video.tags as string[] | null) || []).filter(Boolean).slice(0, 30),
    privacyStatus: args.privacyStatus ?? "public",
  };

  const accessToken = await getFreshYouTubeAccessToken(supabaseAdmin, userId);
  const youtubeId = await uploadMp4ToYouTube(accessToken, bytes, meta);
  await uploadThumbnailIfPresent(supabaseAdmin, accessToken, youtubeId, video.thumbnail_storage_path ?? null);

  const { error: updErr } = await supabaseAdmin
    .from("videos")
    .update({
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      youtube_video_id: youtubeId,
      status: "published",
      uploaded_at: new Date().toISOString(),
      generation_stage: "Uploaded to YouTube 🎉",
      error_message: null,
    } as never)
    .eq("id", videoId)
    .eq("user_id", userId);
  if (updErr) throw new Error(updErr.message);

  return { youtubeVideoId: youtubeId, url: `https://www.youtube.com/watch?v=${youtubeId}` };
}