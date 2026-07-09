import type { ShortsValidation } from "./shorts-validator.server";

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
  // Optional temp storage path (in the `videos` bucket) with a client-side
  // Shorts-ready re-encode. When present, upload THIS file to YouTube and
  // delete it afterwards; the original storage object is never modified.
  preparedStoragePath?: string | null;
  preparedExpected?: boolean;
};

function uploadDiagnostics(details: {
  source: string;
  converted: boolean;
  byteLength: number;
  validation: ShortsValidation;
}) {
  const d = details.validation.details;
  return {
    source: details.source,
    converted: details.converted,
    width: d.width,
    height: d.height,
    displayWidth: d.displayWidth,
    displayHeight: d.displayHeight,
    rotation: d.rotationDeg,
    duration: d.durationSeconds,
    codec: [d.videoCodec, d.audioCodec].filter(Boolean).join("/") || "unknown",
    fileSize: details.byteLength,
    ok: details.validation.ok,
    reasons: details.validation.reasons,
  };
}

function isPortraitNineBySixteen(details: { width?: number; height?: number; rotationDeg?: number }) {
  if (!details.width || !details.height) return false;
  const ratio = details.height / details.width;
  return details.height > details.width && Math.abs(ratio - 16 / 9) < 0.03 && (details.rotationDeg ?? 0) === 0;
}


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
    .select("id,user_id,title,description,tags,video_storage_path,thumbnail_storage_path,video_url")
    .eq("id", videoId)
    .eq("user_id", userId)
    .single();

  if (error || !video) throw new Error(error?.message || "Video not found");
  if (!video.video_storage_path && !video.video_url) throw new Error("No MP4 file is attached to this library item");

  let bytes: ArrayBuffer;
  const preparedPath = args.preparedStoragePath || null;
  if (args.preparedExpected && !preparedPath) {
    throw new Error("Upload-ready copy was expected but no prepared storage path was provided. Aborting before YouTube upload.");
  }
  let selectedSource = "";
  let converted = false;
  if (preparedPath) {
    // Client-prepared Shorts-ready copy. Downloads from a separate temp path;
    // the video's own storage object is NOT read here, so the original file
    // remains byte-identical after upload.
    const { data: blob, error: downErr } = await supabaseAdmin.storage.from("videos").download(preparedPath);
    if (downErr || !blob) throw new Error(`Could not read prepared Shorts-ready copy: ${downErr?.message || "missing file"}`);
    bytes = await blob.arrayBuffer();
    selectedSource = `videos/${preparedPath}`;
    converted = true;
  } else if (video.video_storage_path) {
    const { data: blob, error: downErr } = await supabaseAdmin.storage.from("videos").download(video.video_storage_path);
    if (downErr || !blob) throw new Error(`Could not read video from storage: ${downErr?.message || "missing file"}`);
    bytes = await blob.arrayBuffer();
    selectedSource = `videos/${video.video_storage_path}`;
  } else {
    const res = await fetch(video.video_url!);
    if (!res.ok) throw new Error(`Could not fetch video URL: HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
    selectedSource = video.video_url!;
  }


  // Upload-stage Shorts guarantee: validate the selected MP4, allow only a
  // metadata-only faststart rewrite, and never upload rotation-metadata files.
  let uploadBytes: Uint8Array = new Uint8Array(bytes);
  const { validateShortsMp4 } = await import("./shorts-validator.server");
  const check = validateShortsMp4(uploadBytes);
  console.log("[shorts-upload] Upload-ready MP4 validated.", uploadDiagnostics({
    source: selectedSource,
    converted,
    byteLength: uploadBytes.byteLength,
    validation: check,
  }));
  console.log("USING FILE FOR UPLOAD:", selectedSource);
  console.log(`Converted = ${converted ? "true" : "false"}`);
  console.log("[shorts-upload] pre-upload diagnostics", {
    videoId,
    ok: check.ok,
    reasons: check.reasons,
    needsFaststart: check.needsFaststart,
    needsRotationFix: check.needsRotationFix,
    needsRemux: check.needsRemux,
    details: check.details,
  });
  if (check.needsRemux) {
    throw new Error(`Cannot upload as Short: ${check.reasons.join("; ")}`);
  }
  if (check.needsRotationFix) {
    throw new Error("Selected upload file relies on rotation metadata instead of physical portrait pixels. Aborting before YouTube upload.");
  }
  if (!converted && !isPortraitNineBySixteen(check.details)) {
    throw new Error("Upload attempted to use the original file, but it is not a physical portrait 9:16 MP4. Aborting before YouTube upload.");
  }
  if (check.needsFaststart) {
    const { faststartMp4 } = await import("./shorts-faststart.server");
    uploadBytes = faststartMp4(uploadBytes);
  }
  if (check.needsFaststart) {
    const recheck = validateShortsMp4(uploadBytes);
    console.log("[shorts-upload] post-fix diagnostics", {
      videoId,
      ok: recheck.ok,
      reasons: recheck.reasons,
      details: recheck.details,
    });
    if (!isPortraitNineBySixteen(recheck.details)) {
      throw new Error("Selected upload file is not a physical portrait 9:16 MP4 after validation/fixes. Aborting before YouTube upload.");
    }
  } else if (!isPortraitNineBySixteen(check.details)) {
    throw new Error("Selected upload file is not a physical portrait 9:16 MP4. Aborting before YouTube upload.");
  }

  const meta: UploadMeta = {
    title: (args.title || video.title || "New Short").slice(0, 100),
    description: args.description ?? video.description ?? "",
    tags: (args.tags?.length ? args.tags : (video.tags as string[] | null) || []).filter(Boolean).slice(0, 30),
    privacyStatus: args.privacyStatus ?? "public",
  };

  const accessToken = await getFreshYouTubeAccessToken(supabaseAdmin, userId);
  console.log("[shorts-upload] Upload uses upload-ready MP4.", {
    videoId,
    source: selectedSource,
    converted,
    byteLength: uploadBytes.byteLength,
  });
  const youtubeId = await uploadMp4ToYouTube(accessToken, uploadBytes, meta);
  console.log("[shorts-upload] Upload completes.", { videoId, youtubeId, converted });
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

  // Clean up the client-uploaded temp file. Never touches the original
  // video's storage object (that path is separate).
  if (preparedPath) {
    try {
      await supabaseAdmin.storage.from("videos").remove([preparedPath]);
    } catch (err) {
      console.warn("[shorts-upload] failed to delete temp prepared file", preparedPath, err);
    }
  }



  return { youtubeVideoId: youtubeId, url: `https://www.youtube.com/watch?v=${youtubeId}` };
}