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

type ShortsInspection = {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  isVertical: boolean;
  isDurationOk: boolean;
  details: string;
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

function readU64(view: DataView, offset: number) {
  return Number(view.getBigUint64(offset));
}

function parseMp4Boxes(view: DataView, start: number, end: number, onBox: (type: string, payloadStart: number, payloadEnd: number) => void) {
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    let size = size32;
    let header = 8;
    if (size32 === 1 && offset + 16 <= end) {
      size = readU64(view, offset + 8);
      header = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    onBox(type, offset + header, offset + size);
    offset += size;
  }
}

function parseTkhd(view: DataView, start: number, end: number) {
  if (end - start < 84) return null;
  const version = view.getUint8(start);
  const matrixStart = start + (version === 1 ? 48 : 36);
  if (matrixStart + 44 > end) return null;
  const rawWidth = view.getUint32(end - 8) / 65536;
  const rawHeight = view.getUint32(end - 4) / 65536;
  const a = view.getInt32(matrixStart);
  const b = view.getInt32(matrixStart + 4);
  const c = view.getInt32(matrixStart + 12);
  const d = view.getInt32(matrixStart + 16);
  const rotated = Math.abs(b) > Math.abs(a) && Math.abs(c) > Math.abs(d);
  const width = Math.round(rotated ? rawHeight : rawWidth);
  const height = Math.round(rotated ? rawWidth : rawHeight);
  if (!width || !height) return null;
  return { width, height };
}

function parseMvhdDuration(view: DataView, start: number, end: number) {
  if (end - start < 24) return null;
  const version = view.getUint8(start);
  const timeScaleOffset = start + (version === 1 ? 20 : 12);
  const durationOffset = start + (version === 1 ? 24 : 16);
  if (durationOffset + (version === 1 ? 8 : 4) > end) return null;
  const timeScale = view.getUint32(timeScaleOffset);
  const duration = version === 1 ? readU64(view, durationOffset) : view.getUint32(durationOffset);
  if (!timeScale || !duration) return null;
  return duration / timeScale;
}

function inspectMp4ForShorts(bytes: ArrayBuffer | Uint8Array, storedDurationSeconds?: number | null): ShortsInspection {
  const file = asArrayBuffer(bytes);
  const view = new DataView(file);
  let width: number | null = null;
  let height: number | null = null;
  let durationSeconds: number | null = storedDurationSeconds && storedDurationSeconds > 0 ? storedDurationSeconds : null;

  parseMp4Boxes(view, 0, view.byteLength, (type, payloadStart, payloadEnd) => {
    if (type !== "moov") return;
    parseMp4Boxes(view, payloadStart, payloadEnd, (moovType, moovStart, moovEnd) => {
      if (moovType === "mvhd") durationSeconds = durationSeconds ?? parseMvhdDuration(view, moovStart, moovEnd);
      if (moovType !== "trak") return;
      let trackSize: { width: number; height: number } | null = null;
      let isVideoTrack = false;
      parseMp4Boxes(view, moovStart, moovEnd, (trakType, trakStart, trakEnd) => {
        if (trakType === "tkhd") trackSize = parseTkhd(view, trakStart, trakEnd);
        if (trakType === "mdia") {
          parseMp4Boxes(view, trakStart, trakEnd, (mdiaType, mdiaStart) => {
            if (mdiaType !== "hdlr" || mdiaStart + 12 > trakEnd) return;
            const handler = String.fromCharCode(
              view.getUint8(mdiaStart + 8),
              view.getUint8(mdiaStart + 9),
              view.getUint8(mdiaStart + 10),
              view.getUint8(mdiaStart + 11),
            );
            if (handler === "vide") isVideoTrack = true;
          });
        }
      });
      if (isVideoTrack && trackSize) {
        width = trackSize.width;
        height = trackSize.height;
      }
    });
  });

  const aspect = width && height ? height / width : 0;
  const isVertical = Boolean(width && height && height > width && aspect >= 1.45 && aspect <= 2.25);
  const isDurationOk = Boolean(durationSeconds && durationSeconds <= 60.5);
  const details = `${width ?? "?"}x${height ?? "?"}, ${durationSeconds ? `${durationSeconds.toFixed(1)}s` : "unknown duration"}`;
  return { width, height, durationSeconds, isVertical, isDurationOk, details };
}

function assertShortsReady(inspection: ShortsInspection) {
  if (!inspection.width || !inspection.height) {
    throw new Error("Upload stopped: this MP4 could not be verified as a vertical YouTube Short. Re-split it with the Long → Shorts tool, then upload again.");
  }
  if (!inspection.isVertical) {
    throw new Error(`Upload stopped: this file is ${inspection.details}, not vertical 9:16. Re-split it with the Long → Shorts tool so it uploads as a Short, not a regular video.`);
  }
  if (!inspection.isDurationOk) {
    throw new Error(`Upload stopped: this file is ${inspection.details}. Shorts uploads from this app are capped at 60 seconds so YouTube classifies them as Shorts.`);
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

// Ensures YouTube treats the upload as a Short. YouTube's Shorts shelf
// classifier weighs the #Shorts hashtag in the title/description alongside
// aspect ratio and duration. We append it (case-insensitive check) so a
// vertical 9:16 clip is never misclassified as a regular video.
function ensureShortsHashtag(title: string, description: string) {
  const hasTag = (s: string) => /(^|\s|#)shorts(\b|#|\s|$)/i.test(s);
  const nextTitle = hasTag(title) ? title : `${title} #Shorts`.trim();
  const nextDesc = hasTag(description)
    ? description
    : `${description ? description.trim() + "\n\n" : ""}#Shorts`;
  return { nextTitle: nextTitle.slice(0, 100), nextDesc: nextDesc.slice(0, 5000) };
}

export async function uploadMp4ToYouTube(accessToken: string, bytes: ArrayBuffer | Uint8Array, meta: UploadMeta) {
  const file = asArrayBuffer(bytes);
  const { nextTitle, nextDesc } = ensureShortsHashtag(meta.title, meta.description);
  const tagSet = new Set((meta.tags || []).map((t) => t.trim()).filter(Boolean));
  tagSet.add("Shorts");
  tagSet.add("shorts");
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
        title: nextTitle,
        description: nextDesc,
        tags: Array.from(tagSet).slice(0, 30),
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
    .select("id,user_id,title,description,tags,video_storage_path,thumbnail_storage_path,video_url,duration_seconds")
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

  const shortsInspection = inspectMp4ForShorts(bytes, video.duration_seconds ?? null);
  assertShortsReady(shortsInspection);

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

  return { youtubeVideoId: youtubeId, url: `https://www.youtube.com/shorts/${youtubeId}`, watchUrl: `https://www.youtube.com/watch?v=${youtubeId}`, shortsReady: shortsInspection };
}