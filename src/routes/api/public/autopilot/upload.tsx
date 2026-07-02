import { createFileRoute } from "@tanstack/react-router";

type UploadBody = {
  videoId: string;
  userId: string;
  mp4Base64: string;
  thumbnailBase64?: string;
  title: string;
  description: string;
  tags: string[];
  privacy: "public" | "unlisted" | "private";
  durationSeconds: number;
};

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${tok.error_description || tok.error || res.status}`);
  return tok.access_token as string;
}

async function uploadToYouTube(accessToken: string, mp4: Uint8Array, meta: { title: string; description: string; tags: string[]; privacy: string }): Promise<string> {
  const metadata = {
    snippet: { title: meta.title.slice(0, 100), description: meta.description.slice(0, 4900), tags: meta.tags.slice(0, 30), categoryId: "24" },
    status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
  };
  const boundary = "----ShortForge" + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [
    enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    enc.encode(`--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    mp4,
    enc.encode(`\r\n--${boundary}--\r\n`),
  ];
  const totalLen = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.byteLength; }
  const res = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(totalLen) },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`YouTube upload failed (${res.status}): ${json.error?.message || JSON.stringify(json).slice(0, 400)}`);
  return json.id as string;
}

async function handler(request: Request): Promise<Response> {
  const secret = process.env.AUTOPILOT_SECRET;
  const provided = request.headers.get("x-autopilot-secret");
  if (!secret || provided !== secret) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as UploadBody;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  try {
    const mp4 = new Uint8Array(Buffer.from(body.mp4Base64, "base64"));
    // Store MP4 in Supabase Storage
    const path = `${body.userId}/${body.videoId}/final.mp4`;
    const { error: upErr } = await supabaseAdmin.storage.from("videos").upload(path, mp4, { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);
    const { data: signed } = await supabaseAdmin.storage.from("videos").createSignedUrl(path, 60 * 60 * 24 * 7);

    // Thumbnail
    let thumbPath: string | null = null;
    let thumbUrl: string | null = null;
    if (body.thumbnailBase64) {
      const tbytes = new Uint8Array(Buffer.from(body.thumbnailBase64, "base64"));
      thumbPath = `${body.userId}/${body.videoId}.jpg`;
      await supabaseAdmin.storage.from("thumbnails").upload(thumbPath, tbytes, { contentType: "image/jpeg", upsert: true });
      const { data: ts } = await supabaseAdmin.storage.from("thumbnails").createSignedUrl(thumbPath, 60 * 60 * 24 * 7);
      thumbUrl = ts?.signedUrl ?? null;
    }

    // YouTube upload
    let ytId: string | null = null;
    let ytError: string | null = null;
    const { data: conn } = await supabaseAdmin.from("youtube_connections").select("refresh_token").eq("user_id", body.userId).maybeSingle();
    if (conn?.refresh_token) {
      try {
        const accessToken = await refreshAccessToken(conn.refresh_token);
        ytId = await uploadToYouTube(accessToken, mp4, { title: body.title, description: body.description, tags: body.tags, privacy: body.privacy });
      } catch (err) {
        ytError = err instanceof Error ? err.message : String(err);
      }
    } else {
      ytError = "No YouTube connection";
    }

    await supabaseAdmin.from("videos").update({
      status: "ready",
      video_url: signed?.signedUrl ?? null,
      video_storage_path: path,
      file_size_bytes: mp4.byteLength,
      duration_seconds: Math.round(body.durationSeconds),
      generation_progress: 100,
      generation_stage: ytId ? "Uploaded to YouTube 🎉" : "Rendered (YT upload failed)",
      thumbnail_url: thumbUrl,
      thumbnail_storage_path: thumbPath,
      youtube_video_id: ytId,
      error_message: ytError,
    } as never).eq("id", body.videoId);

    await supabaseAdmin.from("notifications").insert({
      user_id: body.userId,
      title: ytId ? "Autopilot uploaded a Short 🚀" : "Autopilot rendered a Short (upload failed)",
      message: ytId ? `${body.title} — https://youtube.com/shorts/${ytId}` : (ytError || "Rendered but not uploaded"),
    } as never);

    return Response.json({ ok: true, youtubeId: ytId, error: ytError });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabaseAdmin.from("videos").update({ status: "failed", error_message: msg, generation_stage: "Autopilot failed" } as never).eq("id", body.videoId);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/autopilot/upload")({
  server: { handlers: { POST: async ({ request }) => handler(request) } },
});
