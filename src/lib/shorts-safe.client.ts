import { FFmpeg } from "@ffmpeg/ffmpeg";

const CORE_JS_URL = "/ffmpeg-core/ffmpeg-core.js";
const WASM_MANIFEST_URL = "/ffmpeg-core/ffmpeg-core.wasm.asset.json";

let instance: FFmpeg | null = null;
let logs: string[] = [];

type VideoMeta = {
  width: number;
  height: number;
  duration: number;
};

type ShortsSafeResult = {
  bytes: Uint8Array;
  durationSeconds: number;
  changed: boolean;
};

async function getLocalWasmUrl(): Promise<string> {
  const res = await fetch(WASM_MANIFEST_URL, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Cannot load ffmpeg wasm manifest (${res.status})`);
  const manifest = (await res.json()) as { url?: string };
  if (!manifest.url) throw new Error("ffmpeg wasm manifest is missing its asset URL");
  return new URL(manifest.url, window.location.origin).href;
}

async function getFFmpeg(): Promise<FFmpeg> {
  if (instance) return instance;
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => {
    logs.push(message);
    if (logs.length > 160) logs.shift();
  });
  await ff.load({
    coreURL: new URL(CORE_JS_URL, window.location.origin).href,
    wasmURL: await getLocalWasmUrl(),
  });
  instance = ff;
  return ff;
}

function logTail(lines = 10) {
  const compact = logs
    .slice(-lines)
    .map((line) => line.replace(/Last message repeated \d+ times?/gi, "repeated decoder message"))
    .filter((line, index, arr) => line && line !== arr[index - 1]);
  const text = compact.join(" | ") || "no ffmpeg log output";
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
}

async function execWithBrowserBudget(ff: FFmpeg, args: string[], budgetMs: number, label: string) {
  let timeoutId = 0;
  try {
    return await Promise.race([
      ff.exec(args),
      new Promise<number>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          try { ff.terminate(); } catch { /* noop */ }
          instance = null;
          reject(new Error(`${label} took too long in this browser, so upload was stopped before it could get stuck.`));
        }, budgetMs);
      }),
    ]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function readBlobMeta(blob: Blob): Promise<VideoMeta> {
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Could not read MP4 metadata"));
      window.setTimeout(() => {
        if (video.videoWidth) resolve();
        else reject(new Error("Timed out reading MP4 metadata"));
      }, 8000);
    });
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isShortsShape(meta: VideoMeta) {
  const ratio = meta.width / Math.max(meta.height, 1);
  return meta.height > meta.width && Math.abs(ratio - 9 / 16) < 0.015;
}

function verticalBlurFilter(width: number, height: number, fps?: number) {
  const fpsPart = fps ? `,fps=${fps}` : "";
  return [
    "split=2[bg][fg]",
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${width}:${height},boxblur=24:1[bg2]`,
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear[fg2]`,
    `[bg2][fg2]overlay=(W-w)/2:(H-h)/2:format=auto${fpsPart}`,
  ].join(";");
}

export async function fetchVideoBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download MP4 for Shorts check (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function prepareShortsSafeMp4(bytes: Uint8Array, target: "hd" | "4k" = "hd"): Promise<ShortsSafeResult> {
  const sourceBlob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "video/mp4" });
  const meta = await readBlobMeta(sourceBlob);
  if (meta.duration > 60.5) throw new Error(`YouTube Shorts must be 60 seconds or less. This file is ${Math.round(meta.duration)}s.`);

  const targetW = target === "4k" ? 2160 : 1080;
  const targetH = target === "4k" ? 3840 : 1920;
  if (isShortsShape(meta)) {
    return { bytes, durationSeconds: meta.duration, changed: false };
  }

  const ff = await getFFmpeg();
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inName = `shorts-in-${nonce}.mp4`;
  const outName = `shorts-out-${nonce}.mp4`;
  await ff.writeFile(inName, new Uint8Array(bytes));
  try {
    const code = await execWithBrowserBudget(ff, [
      "-y",
      "-fflags", "+genpts+igndts+discardcorrupt",
      "-err_detect", "ignore_err",
      "-i", inName,
      "-t", Math.min(meta.duration || 60, 60).toFixed(2),
      "-vf", verticalBlurFilter(targetW, targetH, 30),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-x264-params", "keyint=60:min-keyint=30:scenecut=0:rc-lookahead=0:ref=1:bframes=0",
      "-crf", target === "4k" ? "22" : "21",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ac", "2",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-threads", "0",
      outName,
    ], target === "4k" ? 120_000 : 55_000, "Shorts-safe conversion");
    if (code !== 0) throw new Error(`Shorts-safe encode failed (${code}): ${logTail()}`);
    const out = await ff.readFile(outName);
    const safe = out instanceof Uint8Array ? new Uint8Array(out) : new TextEncoder().encode(String(out));
    if (safe.byteLength < 80_000) throw new Error("Shorts-safe output is too small; upload stopped to prevent a bad YouTube file.");

    const safeMeta = await readBlobMeta(new Blob([safe.slice().buffer as ArrayBuffer], { type: "video/mp4" }));
    if (!isShortsShape(safeMeta)) throw new Error("Shorts-safe output is not vertical 9:16; upload stopped.");
    return { bytes: safe, durationSeconds: safeMeta.duration || meta.duration, changed: true };
  } finally {
    try { await ff.deleteFile(inName); } catch { /* noop */ }
    try { await ff.deleteFile(outName); } catch { /* noop */ }
  }
}

export async function uploadSignedMp4(signedUrl: string, bytes: Uint8Array) {
  const payload = new FormData();
  payload.append("cacheControl", "3600");
  payload.append("", new Blob([bytes.slice().buffer as ArrayBuffer], { type: "video/mp4" }));
  const res = await fetch(signedUrl, { method: "PUT", body: payload, headers: { "x-upsert": "true" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shorts-safe upload failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
}