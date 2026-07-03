// Browser-side long-video splitter using ffmpeg.wasm. Runs entirely in the
// user's tab — no GitHub Actions, no server worker.
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import type { ClipProgress, ClipResult, SplitOptions } from "./ffmpeg-splitter.types";

const CORE_JS_URL = "/ffmpeg-core/ffmpeg-core.js";
const WASM_MANIFEST_URL = "/ffmpeg-core/ffmpeg-core.wasm.asset.json";

let ffmpegInstance: FFmpeg | null = null;
let recentLogs: string[] = [];

function ffmpegLogTail(lines = 14): string {
  return recentLogs.slice(-lines).join(" | ") || "no ffmpeg log output";
}

async function getLocalWasmUrl(): Promise<string> {
  const res = await fetch(WASM_MANIFEST_URL, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Cannot load ffmpeg wasm manifest (${res.status})`);
  const manifest = (await res.json()) as { url?: string };
  if (!manifest.url) throw new Error("ffmpeg wasm manifest is missing its asset URL");
  return new URL(manifest.url, window.location.origin).href;
}

async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => {
    recentLogs.push(message);
    if (recentLogs.length > 200) recentLogs.shift();
    if (onLog) onLog(message);
  });
  const wasmAssetUrl = await getLocalWasmUrl();
  const coreJsUrl = new URL(CORE_JS_URL, window.location.origin).href;
  await ff.load({
    // Keep the JS loader in this app and the 31MB wasm as a Lovable big asset.
    // This avoids random CDN/CORS failures like "failed to import ffmpeg-core.js".
    coreURL: coreJsUrl,
    wasmURL: wasmAssetUrl,
  });
  ffmpegInstance = ff;
  return ff;
}

function probeDurationFromFile(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = url;
    const done = (d: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(0);
    setTimeout(() => done(v.duration || 0), 8000);
  });
}

function pickWindows(duration: number, clipLen: number, maxClips: number) {
  const wins: Array<{ start: number; end: number }> = [];
  const usable = Math.max(0, duration - 1);
  if (usable <= clipLen) return [{ start: 0, end: Math.min(duration, clipLen) }];
  const gap = usable / (maxClips + 1);
  for (let i = 1; i <= maxClips; i++) {
    const start = Math.max(0, i * gap - clipLen / 2);
    const end = Math.min(duration, start + clipLen);
    if (end - start >= 10) wins.push({ start, end });
  }
  return wins;
}

type EncodeTarget = { w: number; h: number; bitrate: string; preset: string; crf: string };

const TARGETS: Record<"4k" | "1440p" | "1080p", EncodeTarget> = {
  "4k":    { w: 2160, h: 3840, bitrate: "18M", preset: "ultrafast", crf: "22" },
  "1440p": { w: 1440, h: 2560, bitrate: "14M", preset: "ultrafast", crf: "20" },
  "1080p": { w: 1080, h: 1920, bitrate: "10M", preset: "veryfast", crf: "19" },
};

async function makeThumbnailFromMp4(mp4: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(mp4.byteLength);
  new Uint8Array(buffer).set(mp4);
  const blob = new Blob([buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  const fallbackThumbnail = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas thumbnail renderer unavailable");
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#05050a");
    gradient.addColorStop(0.45, "#7c3aed");
    gradient.addColorStop(1, "#06b6d4");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "bold 64px Inter, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("SHORTS CLIP", canvas.width / 2, canvas.height / 2 - 20);
    ctx.font = "34px Inter, Arial, sans-serif";
    ctx.fillText("Ready to publish", canvas.width / 2, canvas.height / 2 + 42);
    const jpg = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Fallback thumbnail export failed"))), "image/jpeg", 0.9),
    );
    return new Uint8Array(await jpg.arrayBuffer());
  };

  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;
    const loaded = await new Promise<boolean>((resolve) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => resolve(false);
      setTimeout(() => resolve(Boolean(video.videoWidth)), 5000);
    });
    if (!loaded || !video.videoWidth) return await fallbackThumbnail();
    const targetTime = Math.min(Math.max((video.duration || 1) * 0.25, 0.15), Math.max((video.duration || 1) - 0.1, 0.15));
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = targetTime;
      setTimeout(() => resolve(), 3000);
    });
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas thumbnail renderer unavailable");
    ctx.fillStyle = "#05050a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(canvas.width / (video.videoWidth || 1), canvas.height / (video.videoHeight || 1));
    const w = (video.videoWidth || canvas.width) * scale;
    const h = (video.videoHeight || canvas.height) * scale;
    ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    const jpg = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Thumbnail canvas export failed"))), "image/jpeg", 0.88),
    );
    return new Uint8Array(await jpg.arrayBuffer());
  } catch {
    return await fallbackThumbnail();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encodeClip(
  ff: FFmpeg,
  inputName: string,
  clipName: string,
  startSec: number,
  durSec: number,
  target: EncodeTarget,
): Promise<void> {
  const vf = [
    `scale=${target.w}:${target.h}:force_original_aspect_ratio=increase`,
    `crop=${target.w}:${target.h}`,
    "fps=30",
  ].join(",");

  let code: number;
  try {
    code = await ff.exec([
    "-y",
    "-ss", String(startSec),
    "-i", inputName,
    "-t", durSec.toFixed(2),
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", target.preset,
    "-crf", target.crf,
    "-b:v", target.bitrate,
    "-maxrate", target.bitrate,
    "-bufsize", target.bitrate,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    clipName,
    ]);
  } catch (err) {
    throw new Error(`ffmpeg crashed @ ${target.w}x${target.h}: ${err instanceof Error ? err.message : String(err)} · ${ffmpegLogTail()}`);
  }
  if (code !== 0) {
    throw new Error(`ffmpeg exit ${code} @ ${target.w}x${target.h}: ${ffmpegLogTail()}`);
  }
}

export async function splitVideoInBrowser(file: File, opts: SplitOptions): Promise<ClipResult[]> {
  const preferred: EncodeTarget = opts.resolution === "4k" ? TARGETS["4k"] : TARGETS["1080p"];
  const fallback: EncodeTarget = opts.resolution === "4k" ? TARGETS["1440p"] : TARGETS["1080p"];

  const notify = (patch: Partial<ClipProgress> & Pick<ClipProgress, "stage" | "message">) => {
    opts.onProgress({
      index: 0,
      total: 0,
      percent: 0,
      clipPercent: 0,
      etaSeconds: null,
      fps: null,
      uploadMBps: null,
      ...patch,
    } as ClipProgress);
  };

  notify({ stage: "probing", message: "Reading video metadata…" });
  const duration = (await probeDurationFromFile(file)) || 60;

  notify({ stage: "loading-ffmpeg", message: "Loading ffmpeg engine (first time only, ~30MB)…" });
  const ff = await getFFmpeg();

  notify({ stage: "reading-file", message: `Loading ${(file.size / 1024 / 1024).toFixed(1)}MB into ffmpeg…` });
  const inputName = "input.mp4";
  await ff.writeFile(inputName, await fetchFile(file));

  const windows = pickWindows(duration, opts.clipLength, opts.maxClips);
  const total = windows.length;
  const startedAt = Date.now();
  const results: ClipResult[] = [];

  const onProgress = ({ progress }: { progress: number; time: number }) => {
    const clipPct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const overallDone = results.length + Math.max(0, Math.min(1, progress));
    const percent = Math.round((overallDone / Math.max(total, 1)) * 100);
    const eta = percent > 3 ? Math.round((elapsedSec / percent) * (100 - percent)) : null;
    notify({
      index: results.length + 1,
      total,
      stage: "encoding",
      percent,
      clipPercent: clipPct,
      etaSeconds: eta,
      fps: null,
      uploadMBps: null,
      message: `Encoding clip ${results.length + 1} of ${total} (${clipPct}%)`,
    });
  };
  ff.on("progress", onProgress);

  try {
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const dur = w.end - w.start;
      const clipName = `clip${i + 1}.mp4`;

      let usedTarget = preferred;
      try {
        await encodeClip(ff, inputName, clipName, w.start, dur, preferred);
      } catch (err) {
        console.warn("[splitter] preferred target failed, retrying at fallback", err);
        notify({
          index: i + 1, total, stage: "encoding", percent: Math.round((i / total) * 100),
          clipPercent: 0, etaSeconds: null, fps: null, uploadMBps: null,
          message: `${preferred.w}p failed for clip ${i + 1}, retrying at ${fallback.w}×${fallback.h}…`,
        });
        usedTarget = fallback;
        await encodeClip(ff, inputName, clipName, w.start, dur, fallback);
      }

      let mp4Data: Awaited<ReturnType<FFmpeg["readFile"]>>;
      try {
        mp4Data = await ff.readFile(clipName);
      } catch (err) {
        throw new Error(`Generated MP4 could not be read for clip ${i + 1}: ${err instanceof Error ? err.message : String(err)} · ${ffmpegLogTail()}`);
      }
      const mp4 = mp4Data instanceof Uint8Array ? mp4Data : new TextEncoder().encode(String(mp4Data));
      const thumb = await makeThumbnailFromMp4(mp4);

      results.push({
        index: i + 1,
        startSeconds: w.start,
        endSeconds: w.end,
        mp4,
        thumbnailJpg: thumb,
        title: `Clip ${i + 1} · ${Math.round(w.start)}s–${Math.round(w.end)}s · ${usedTarget.h}p`,
      });

      try { await ff.deleteFile(clipName); } catch {}
    }
  } finally {
    ff.off("progress", onProgress);
    try { await ff.deleteFile(inputName); } catch {}
  }

  notify({ stage: "done", percent: 100, clipPercent: 100, message: `Generated ${results.length} clip${results.length === 1 ? "" : "s"}.` });
  return results;
}
