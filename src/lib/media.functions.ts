import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { experimental_generateVideo as generateVideo, generateImage, generateText } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import type { GeneratedScript } from "./scripts.functions";

const SceneSchema = z.object({
  order: z.number(),
  visualPrompt: z.string(),
  voiceover: z.string(),
  onScreenText: z.string(),
  durationSeconds: z.number(),
});

const ScriptSchema = z.object({
  title: z.string(),
  hook: z.string(),
  scenes: z.array(SceneSchema),
  fullVoiceover: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
  seoKeywords: z.array(z.string()),
});

const MetadataSchema = z.object({
  titleOptions: z.array(z.string()).min(1).max(5),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()).min(5).max(25),
  hashtags: z.array(z.string()).min(3).max(12),
  keywords: z.array(z.string()).min(3).max(20),
});

type Metadata = z.infer<typeof MetadataSchema>;

type SupabaseAdmin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

const StartVideoInput = z.object({
  script: ScriptSchema,
  durationSeconds: z.number().int().min(4).max(90),
  existingVideoId: z.string().uuid().optional(),
});

const MetadataInput = z.object({
  videoId: z.string().uuid(),
  topic: z.string().min(2).max(400).optional(),
  script: ScriptSchema.optional(),
});

const UploadYouTubeInput = z.object({
  videoId: z.string().uuid(),
  title: z.string().min(1).max(100),
  description: z.string().max(5000).default(""),
  tags: z.array(z.string()).max(30).default([]),
  privacyStatus: z.enum(["public", "unlisted", "private"]).default("private"),
});

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("Model did not return JSON");
  return JSON.parse(candidate.slice(first, last + 1));
}

function compactScript(script: GeneratedScript) {
  return [
    `Title: ${script.title}`,
    `Hook: ${script.hook}`,
    `Voiceover: ${script.fullVoiceover}`,
    "Scenes:",
    ...script.scenes.map((s) => `${s.order}. Visual: ${s.visualPrompt} | VO: ${s.voiceover} | Text: ${s.onScreenText}`),
  ].join("\n");
}

function providerErrorMessage(err: unknown) {
  if (err instanceof Error) {
    const anyErr = err as Error & { statusCode?: number; responseBody?: string; data?: unknown; cause?: unknown };
    const parts = [anyErr.message];
    if (anyErr.statusCode) parts.push(`HTTP ${anyErr.statusCode}`);
    if (anyErr.responseBody) parts.push(anyErr.responseBody.slice(0, 800));
    if (anyErr.data) parts.push(JSON.stringify(anyErr.data).slice(0, 800));
    return parts.filter(Boolean).join(" — ");
  }
  return String(err);
}

function createVideoGateway() {
  const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY/AI_GATEWAY_API_KEY is not configured");
  const usingLovableKey = !process.env.AI_GATEWAY_API_KEY;
  return createGateway({
    apiKey,
    baseURL: process.env.AI_GATEWAY_BASE_URL || (usingLovableKey ? "https://ai.gateway.lovable.dev/v4/ai" : undefined),
    headers: usingLovableKey
      ? {
          "Lovable-API-Key": apiKey,
          "X-Lovable-AIG-SDK": "vercel-ai-sdk",
        }
      : undefined,
  });
}

export const ScheduledScriptInput = z.object({
  niche: z.string().min(2).max(300),
  tone: z.string().min(2).max(80).default("energetic and punchy"),
  hookStyle: z.string().min(2).max(80).default("shocking statistic"),
  durationSeconds: z.number().int().min(15).max(90).default(45),
});

export async function generateScriptWithGemini(input: z.infer<typeof ScheduledScriptInput>): Promise<GeneratedScript> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY not configured");
  const provider = createLovableAiGatewayProvider(key);
  const model = provider("google/gemini-2.5-flash");
  const sceneCount = Math.max(3, Math.round(input.durationSeconds / 6));
  const { text } = await generateText({
    model,
    system: `You write viral YouTube Shorts scripts optimised for retention. Return ONLY a JSON object (no markdown) matching:
{
  "title": string,
  "hook": string,
  "scenes": [{"order": number, "visualPrompt": string, "voiceover": string, "onScreenText": string, "durationSeconds": number}],
  "fullVoiceover": string,
  "description": string,
  "hashtags": string[],
  "seoKeywords": string[]
}`,
    prompt: `Niche: ${input.niche}
Tone: ${input.tone}
Hook style: ${input.hookStyle}
Target duration: ${input.durationSeconds} seconds
Create exactly ${sceneCount} scenes whose durations sum to roughly ${input.durationSeconds} seconds.`,
  });
  return ScriptSchema.parse(extractJson(text)) as GeneratedScript;
}

async function generateMetadataWithGemini(input: { topic?: string; script?: GeneratedScript; fileName?: string }): Promise<Metadata> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY not configured");
  const provider = createLovableAiGatewayProvider(key);
  const model = provider("google/gemini-2.5-flash");
  const source = input.script ? compactScript(input.script) : `Topic/file: ${input.topic || input.fileName || "Uploaded YouTube Short"}`;
  const { text } = await generateText({
    model,
    system: `You create SEO metadata for YouTube Shorts. Return ONLY JSON matching:
{
  "titleOptions": string[5], // each <=60 chars, includes primary keyword and hook
  "title": string,           // selected best option <=60 chars
  "description": string,     // about 200 words, CTA, keywords, line breaks/bullets
  "tags": string[],          // 15-20 tags, no #
  "hashtags": string[],      // 5-10, each starts with #
  "keywords": string[]       // 5-15 SEO keywords
}`,
    prompt: source,
  });
  const parsed = MetadataSchema.parse(extractJson(text));
  return {
    ...parsed,
    titleOptions: parsed.titleOptions.map((t) => t.slice(0, 60)),
    title: parsed.title.slice(0, 60),
    hashtags: parsed.hashtags.map((h) => (h.startsWith("#") ? h : `#${h.replace(/^#+/, "")}`)),
  };
}

async function uploadBytes(bucket: "videos" | "thumbnails", path: string, bytes: Uint8Array, contentType: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.storage.from(bucket).upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  const { data } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7);
  return { path, signedUrl: data?.signedUrl ?? null };
}

async function maybeGenerateThumbnail(userId: string, videoId: string, metadata: Metadata) {
  try {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY not configured");
    const provider = createLovableAiGatewayProvider(key);
    const result = await generateImage({
      model: provider.imageModel("openai/gpt-image-1-mini"),
      prompt: `Create a high-contrast YouTube Shorts thumbnail, 16:9, bright colors, bold visual hook, no tiny text. Topic/title: ${metadata.title}. Keywords: ${metadata.keywords.join(", ")}`,
      size: "1280x720",
      n: 1,
    });
    const file = result.images[0];
    if (!file) throw new Error("No image returned");
    return await uploadBytes("thumbnails", `${userId}/${videoId}.png`, file.uint8Array, file.mediaType || "image/png");
  } catch (err) {
    // Thumbnail failure should not throw away an otherwise completed video/upload.
    return { path: null, signedUrl: null, error: providerErrorMessage(err) };
  }
}

export const generateMetadataForVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => MetadataInput.parse(raw))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: video, error: readErr } = await supabaseAdmin
      .from("videos")
      .select("id,user_id,title,thumbnail_storage_path")
      .eq("id", data.videoId)
      .eq("user_id", context.userId)
      .single();
    if (readErr || !video) throw new Error(readErr?.message || "Video not found");
    const metadata = await generateMetadataWithGemini({ topic: data.topic, script: data.script as GeneratedScript | undefined, fileName: video.title });
    const thumbnail = await maybeGenerateThumbnail(context.userId, data.videoId, metadata);
    const { error } = await supabaseAdmin
      .from("videos")
      .update({
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        hashtags: metadata.hashtags,
        seo_keywords: metadata.keywords,
        metadata_options: { titleOptions: metadata.titleOptions, thumbnailError: "error" in thumbnail ? thumbnail.error : null },
        thumbnail_url: thumbnail.signedUrl,
        thumbnail_storage_path: thumbnail.path,
      } as never)
      .eq("id", data.videoId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { metadata, thumbnailError: "error" in thumbnail ? thumbnail.error : null };
  });

async function runVideoGenerationForUser(args: {
  supabaseAdmin: SupabaseAdmin;
  userId: string;
  script: GeneratedScript;
  durationSeconds: number;
  existingVideoId?: string;
  scheduledFor?: string | null;
  generationJobId?: string | null;
}) {
  const { supabaseAdmin, userId, script } = args;
  const metadata = await generateMetadataWithGemini({ script });

  let videoId = args.existingVideoId;
  if (!videoId) {
    const { data: row, error } = await supabaseAdmin
      .from("videos")
      .insert({
        user_id: userId,
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        hashtags: metadata.hashtags,
        seo_keywords: metadata.keywords,
        metadata_options: { titleOptions: metadata.titleOptions },
        script: JSON.parse(JSON.stringify(script)),
        duration_seconds: args.durationSeconds,
        status: "generating_video",
        generation_progress: 5,
        generation_stage: "Initializing Veo 3.1 engine...",
        scheduled_for: args.scheduledFor,
        generation_job_id: args.generationJobId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    videoId = row.id;
  } else {
    const { error } = await supabaseAdmin
      .from("videos")
      .update({
        status: "generating_video",
        generation_progress: 5,
        generation_stage: "Initializing Veo 3.1 engine...",
        error_message: null,
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        hashtags: metadata.hashtags,
        seo_keywords: metadata.keywords,
        metadata_options: { titleOptions: metadata.titleOptions },
        script: JSON.parse(JSON.stringify(script)),
        duration_seconds: args.durationSeconds,
        scheduled_for: args.scheduledFor ?? undefined,
        generation_job_id: args.generationJobId ?? undefined,
      } as never)
      .eq("id", videoId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
  }

  const updateStage = async (generation_progress: number, generation_stage: string) => {
    await supabaseAdmin.from("videos").update({ generation_progress, generation_stage } as never).eq("id", videoId!).eq("user_id", userId);
  };

  try {
    const thumbnail = await maybeGenerateThumbnail(userId, videoId, metadata);
    await supabaseAdmin
      .from("videos")
      .update({
        thumbnail_url: thumbnail.signedUrl,
        thumbnail_storage_path: thumbnail.path,
        metadata_options: { titleOptions: metadata.titleOptions, thumbnailError: "error" in thumbnail ? thumbnail.error : null },
      } as never)
      .eq("id", videoId)
      .eq("user_id", userId);

    await updateStage(18, `Generating scene 1 of ${script.scenes.length}...`);
    const gateway = createVideoGateway();
    const veoDuration = Math.min(8, Math.max(4, Math.round(args.durationSeconds / Math.max(script.scenes.length, 1))));
    const prompt = `Vertical YouTube Short, cinematic, 9:16, complete story in one clip. Use this script as creative direction, include synchronized natural audio/ambience and voiceover style pacing. Avoid subtitles unless specified.

${compactScript(script)}`;
    await updateStage(45, "Rendering frames...");
    const result = await generateVideo({
      model: gateway.videoModel("google/veo-3.1-generate-001"),
      prompt,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      duration: veoDuration,
      generateAudio: true,
      maxRetries: 0,
    });
    await updateStage(75, "Adding audio track...");
    const video = result.video;
    if (!video?.uint8Array?.length) throw new Error("Veo returned no video bytes");
    await updateStage(88, "Encoding final video...");
    const stored = await uploadBytes("videos", `${userId}/${videoId}.mp4`, video.uint8Array, video.mediaType || "video/mp4");
    const { error: updErr } = await supabaseAdmin
      .from("videos")
      .update({
        status: "ready",
        generation_progress: 100,
        generation_stage: "Video ready! 🎉",
        video_url: stored.signedUrl,
        video_storage_path: stored.path,
        file_size_bytes: video.uint8Array.byteLength,
        duration_seconds: veoDuration,
        error_message: null,
      } as never)
      .eq("id", videoId)
      .eq("user_id", userId);
    if (updErr) throw new Error(updErr.message);
    return { videoId, metadata, videoUrl: stored.signedUrl, warning: veoDuration < args.durationSeconds ? `Veo generated an ${veoDuration}s clip because this Gateway route does not accept ${args.durationSeconds}s in one request. The app stores the exact provider output instead of faking length.` : null };
  } catch (err) {
    const reason = providerErrorMessage(err);
    await supabaseAdmin
      .from("videos")
      .update({ status: "failed", generation_progress: 0, generation_stage: "Video generation failed", error_message: reason } as never)
      .eq("id", videoId)
      .eq("user_id", userId);
    throw new Error(`Video generation failed: ${reason}`);
  }
}

export async function generateScheduledVideoForUser(args: {
  userId: string;
  niche: string;
  tone: string;
  hookStyle: string;
  durationSeconds: number;
  scheduledFor?: string | null;
  generationJobId?: string | null;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const script = await generateScriptWithGemini({
    niche: args.niche,
    tone: args.tone,
    hookStyle: args.hookStyle,
    durationSeconds: args.durationSeconds,
  });
  return runVideoGenerationForUser({
    supabaseAdmin,
    userId: args.userId,
    script,
    durationSeconds: args.durationSeconds,
    scheduledFor: args.scheduledFor,
    generationJobId: args.generationJobId,
  });
}

export const startVideoGeneration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => StartVideoInput.parse(raw))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return runVideoGenerationForUser({
      supabaseAdmin,
      userId: context.userId,
      script: data.script as GeneratedScript,
      durationSeconds: data.durationSeconds,
      existingVideoId: data.existingVideoId,
    });
  });

async function getFreshAccessToken(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: conn, error } = await supabaseAdmin
    .from("youtube_connections")
    .select("access_token, refresh_token, token_expires_at, scope")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!conn) throw new Error("No YouTube channel connected");
  if (!conn.scope?.includes("youtube.upload")) throw new Error("Reconnect YouTube: upload permission is missing from the saved Google token.");
  let accessToken = conn.access_token;
  if (new Date(conn.token_expires_at).getTime() - Date.now() < 300_000) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("Google OAuth client secrets are not configured");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: conn.refresh_token, grant_type: "refresh_token" }),
    });
    const tok = await res.json();
    if (!res.ok) throw new Error(`Google token refresh failed: ${tok.error_description || tok.error || JSON.stringify(tok)}`);
    accessToken = tok.access_token;
    await supabaseAdmin
      .from("youtube_connections")
      .update({ access_token: accessToken, token_expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString() } as never)
      .eq("user_id", userId);
  }
  return accessToken;
}

export const uploadVideoToYouTube = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => UploadYouTubeInput.parse(raw))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: video, error } = await supabaseAdmin
      .from("videos")
      .select("id,user_id,video_storage_path,thumbnail_storage_path,video_url")
      .eq("id", data.videoId)
      .eq("user_id", context.userId)
      .single();
    if (error || !video) throw new Error(error?.message || "Video not found");
    if (!video.video_storage_path && !video.video_url) throw new Error("No MP4 file is attached to this library item");
    const accessToken = await getFreshAccessToken(context.userId);
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
    const initRes = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(bytes.byteLength),
      },
      body: JSON.stringify({
        snippet: { title: data.title, description: data.description, tags: data.tags, categoryId: "22" },
        status: { privacyStatus: data.privacyStatus, selfDeclaredMadeForKids: false },
      }),
    });
    const initText = await initRes.text();
    if (!initRes.ok) throw new Error(`YouTube upload init failed: HTTP ${initRes.status} ${initText}`);
    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) throw new Error("YouTube upload init failed: missing resumable upload URL");
    const uploadRes = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.byteLength) }, body: bytes });
    const uploadJson = await uploadRes.json().catch(async () => ({ raw: await uploadRes.text().catch(() => "") }));
    if (!uploadRes.ok) throw new Error(`YouTube upload failed: HTTP ${uploadRes.status} ${JSON.stringify(uploadJson)}`);
    const youtubeId = uploadJson.id as string | undefined;
    if (!youtubeId) throw new Error(`YouTube upload succeeded but no video id returned: ${JSON.stringify(uploadJson)}`);

    if (video.thumbnail_storage_path) {
      try {
        const { data: thumb } = await supabaseAdmin.storage.from("thumbnails").download(video.thumbnail_storage_path);
        if (thumb) {
          const thumbBytes = await thumb.arrayBuffer();
          await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(youtubeId)}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": thumb.type || "image/png" },
            body: thumbBytes,
          });
        }
      } catch (thumbErr) {
        console.warn("Thumbnail upload failed", thumbErr);
      }
    }

    const { error: updErr } = await supabaseAdmin
      .from("videos")
      .update({ youtube_video_id: youtubeId, status: "published", uploaded_at: new Date().toISOString() } as never)
      .eq("id", data.videoId)
      .eq("user_id", context.userId);
    if (updErr) throw new Error(updErr.message);
    return { youtubeVideoId: youtubeId, url: `https://www.youtube.com/watch?v=${youtubeId}` };
  });
