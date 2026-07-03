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
  await ff.load({ coreURL: coreJsUrl, wasmURL: wasmAssetUrl });
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
  if (!Number.isFinite(duration) || duration <= 0) return [{ start: 0, end: clipLen }];
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

// Cinematic polish filter chain: crisp lanczos scale, subtle sharpen, punchy
// color, soft vignette and fade in/out. This is what stops shorts from
// looking like raw cuts.
function polishFilter(clipDurationSec: number, w = 1080, h = 1920): string {
  const fadeOutStart = Math.max(clipDurationSec - 0.5, 0.1).toFixed(2);
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${w}:${h}`,
    "unsharp=5:5:0.7:5:5:0.0",
    "eq=saturation=1.18:contrast=1.06:brightness=0.02",
    "vignette=PI/6",
    "fade=t=in:st=0:d=0.35",
    `fade=t=out:st=${fadeOutStart}:d=0.5`,
    "fps=30",
  ].join(",");
}

async function makeThumbnailFromMp4(mp4: Uint8Array): Promise<{ jpg: Uint8Array; frames: string[] }> {
  const buffer = new ArrayBuffer(mp4.byteLength);
  new Uint8Array(buffer).set(mp4);
  const blob = new Blob([buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  const frames: string[] = [];

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
      video.onloadedmetadata = () => resolve(true);
      video.onerror = () => resolve(false);
      setTimeout(() => resolve(Boolean(video.videoWidth)), 5000);
    });
    if (!loaded || !video.videoWidth) return { jpg: await fallbackThumbnail(), frames };

    const dur = Math.max(video.duration || 1, 0.5);
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { jpg: await fallbackThumbnail(), frames };

    // Sample 3 frames + 1 for thumbnail — feeds Gemini vision for real titles.
    const frameTimes = [0.15, 0.5, 0.85].map((p) => Math.min(Math.max(p * dur, 0.1), dur - 0.05));
    let thumbBlob: Blob | null = null;
    for (let i = 0; i < frameTimes.length; i++) {
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = frameTimes[i];
        setTimeout(() => resolve(), 2500);
      });
      ctx.fillStyle = "#05050a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.max(canvas.width / (video.videoWidth || 1), canvas.height / (video.videoHeight || 1));
      const w = (video.videoWidth || canvas.width) * scale;
      const h = (video.videoHeight || canvas.height) * scale;
      ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      // Small JPEGs (~40-80KB) — cheap for Gemini vision.
      const smallCanvas = document.createElement("canvas");
      smallCanvas.width = 480;
      smallCanvas.height = 854;
      const sctx = smallCanvas.getContext("2d");
      if (sctx) {
        sctx.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
        frames.push(smallCanvas.toDataURL("image/jpeg", 0.72));
      }
      if (i === 1) {
        thumbBlob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("thumbnail export failed"))), "image/jpeg", 0.88),
        );
      }
    }
    const jpg = thumbBlob ? new Uint8Array(await thumbBlob.arrayBuffer()) : await fallbackThumbnail();
    return { jpg, frames };
  } catch {
    return { jpg: await fallbackThumbnail(), frames };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Instant stream-copy cut. Preserves source quality/resolution. ~1-2s per clip.
async function cutClipInstant(ff: FFmpeg, inputName: string, clipName: string, startSec: number, durSec: number) {
  const code = await ff.exec([
    "-y",
    "-ss", String(startSec),
    "-i", inputName,
    "-t", durSec.toFixed(2),
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    clipName,
  ]);
  if (code !== 0) throw new Error(`instant copy exit ${code}: ${ffmpegLogTail()}`);
}

// One-pass polish encode: cut + cinematic filter chain at 1080x1920.
async function encodePolishedClip(
  ff: FFmpeg,
  inputName: string,
  clipName: string,
  startSec: number,
  durSec: number,
) {
  const vf = polishFilter(durSec, 1080, 1920);
  const code = await ff.exec([
    "-y",
    "-ss", String(startSec),
    "-i", inputName,
    "-t", durSec.toFixed(2),
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-af", "afade=t=in:st=0:d=0.3,afade=t=out:st=" + Math.max(durSec - 0.5, 0.1).toFixed(2) + ":d=0.5",
    "-movflags", "+faststart",
    clipName,
  ]);
  if (code !== 0) throw new Error(`polish encode exit ${code}: ${ffmpegLogTail()}`);
}

async function readValidMp4(ff: FFmpeg, clipName: string, clipIndex: number): Promise<Uint8Array> {
  const mp4Data = await ff.readFile(clipName);
  const mp4 = mp4Data instanceof Uint8Array ? mp4Data : new TextEncoder().encode(String(mp4Data));
  if (mp4.byteLength < 50_000) {
    throw new Error(`Generated clip ${clipIndex} is empty (${mp4.byteLength} bytes). ${ffmpegLogTail()}`);
  }
  return mp4;
}

export async function splitVideoInBrowser(file: File, opts: SplitOptions): Promise<ClipResult[]> {
  const notify = (patch: Partial<ClipProgress> & Pick<ClipProgress, "stage" | "message">) => {
    opts.onProgress({
      index: 0, total: 0, percent: 0, clipPercent: 0,
      etaSeconds: null, fps: null, uploadMBps: null,
      ...patch,
    } as ClipProgress);
  };

  notify({ stage: "probing", message: "Reading video metadata…" });
  const probedDuration = await probeDurationFromFile(file);
  const duration = probedDuration > 0 ? probedDuration : opts.clipLength;

  notify({ stage: "loading-ffmpeg", message: "Loading ffmpeg engine (first time only, ~30MB)…" });
  const ff = await getFFmpeg();

  notify({ stage: "reading-file", message: `Loading ${(file.size / 1024 / 1024).toFixed(1)}MB into ffmpeg…` });
  const inputName = "input.mp4";
  await ff.writeFile(inputName, await fetchFile(file));

  const windows = pickWindows(duration, opts.clipLength, opts.maxClips);
  const total = windows.length;
  const startedAt = Date.now();
  const results: ClipResult[] = [];

  const onProgress = ({ progress }: { progress: number }) => {
    const clipPct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const overallDone = results.length + Math.max(0, Math.min(1, progress));
    const percent = Math.round((overallDone / Math.max(total, 1)) * 100);
    const eta = percent > 3 ? Math.round((elapsedSec / percent) * (100 - percent)) : null;
    notify({
      index: results.length + 1, total,
      stage: opts.polish ? "polishing" : "encoding",
      percent, clipPercent: clipPct, etaSeconds: eta, fps: null, uploadMBps: null,
      message: opts.polish
        ? `Polishing clip ${results.length + 1} of ${total} (${clipPct}%) — cinematic pass`
        : `Cutting clip ${results.length + 1} of ${total} (${clipPct}%)`,
    });
  };
  ff.on("progress", onProgress);

  try {
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const dur = w.end - w.start;
      const clipName = `clip${i + 1}.mp4`;
      let mp4: Uint8Array | null = null;

      try {
        if (opts.polish) {
          await encodePolishedClip(ff, inputName, clipName, w.start, dur);
        } else {
          await cutClipInstant(ff, inputName, clipName, w.start, dur);
        }
        mp4 = await readValidMp4(ff, clipName, i + 1);
      } catch (err) {
        console.warn("[splitter] primary path failed, retrying with instant copy", err);
        try { await ff.deleteFile(clipName); } catch { /* noop */ }
        await cutClipInstant(ff, inputName, clipName, w.start, dur);
        mp4 = await readValidMp4(ff, clipName, i + 1);
      }
      if (!mp4) throw new Error(`Generated clip ${i + 1} is missing after encode.`);

      const { jpg, frames } = await makeThumbnailFromMp4(mp4);
      results.push({
        index: i + 1,
        startSeconds: w.start,
        endSeconds: w.end,
        mp4,
        thumbnailJpg: jpg,
        frames,
        needsUpscale: opts.resolution === "4k-smart",
        title: `Clip ${i + 1} · ${Math.round(w.start)}s–${Math.round(w.end)}s`,
      });

      try { await ff.deleteFile(clipName); } catch { /* noop */ }
    }
  } finally {
    ff.off("progress", onProgress);
    try { await ff.deleteFile(inputName); } catch { /* noop */ }
  }

  notify({
    stage: "done", percent: 100, clipPercent: 100,
    message: `Generated ${results.length} polished clip${results.length === 1 ? "" : "s"}.`,
  });
  return results;
}

// Smart-4K background upscale: takes an existing 1080p MP4 and re-encodes to
// 2160x3840 with lanczos + sharpen. Called AFTER instant HD clips are already
// live in the library, so the user is never blocked on 4K encode time.
export async function upscaleClipTo4K(
  mp4: Uint8Array,
  onProgress?: (pct: number) => void,
): Promise<Uint8Array> {
  const ff = await getFFmpeg();
  const inName = `up_in_${Date.now()}.mp4`;
  const outName = `up_out_${Date.now()}.mp4`;
  await ff.writeFile(inName, mp4);

  const handler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(100, Math.round(progress * 100))));
  };
  ff.on("progress", handler);
  try {
    const vf = [
      "scale=2160:3840:flags=lanczos:force_original_aspect_ratio=increase",
      "crop=2160:3840",
      "unsharp=5:5:0.8:5:5:0.0",
    ].join(",");
    const code = await ff.exec([
      "-y",
      "-i", inName,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "24",
      "-maxrate", "16M",
      "-bufsize", "24M",
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "-movflags", "+faststart",
      outName,
    ]);
    if (code !== 0) throw new Error(`4K upscale exit ${code}: ${ffmpegLogTail()}`);
    const out = await ff.readFile(outName);
    const bytes = out instanceof Uint8Array ? out : new TextEncoder().encode(String(out));
    if (bytes.byteLength < 100_000) throw new Error("4K output too small — treating as failure");
    return bytes;
  } finally {
    ff.off("progress", handler);
    try { await ff.deleteFile(inName); } catch { /* noop */ }
    try { await ff.deleteFile(outName); } catch { /* noop */ }
  }
}
