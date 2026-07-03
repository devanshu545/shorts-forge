// Browser-side long-video splitter using ffmpeg.wasm. Runs entirely in the
// user's tab — no GitHub Actions, no server worker.
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { ClipProgress, ClipResult, SplitOptions } from "./ffmpeg-splitter.types";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegInstance: FFmpeg | null = null;
let recentLogs: string[] = [];

async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => {
    recentLogs.push(message);
    if (recentLogs.length > 200) recentLogs.shift();
    if (onLog) onLog(message);
  });
  await ff.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
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

  const code = await ff.exec([
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
  if (code !== 0) {
    const tail = recentLogs.slice(-8).join(" | ");
    throw new Error(`ffmpeg exit ${code} @ ${target.w}x${target.h}: ${tail}`);
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
      const thumbName = `thumb${i + 1}.jpg`;

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

      // Thumbnail
      const mid = (dur / 2).toFixed(2);
      await ff.exec([
        "-y", "-ss", mid, "-i", clipName,
        "-vframes", "1", "-vf", "scale=720:1280", "-q:v", "3",
        thumbName,
      ]);

      const mp4Data = await ff.readFile(clipName);
      const thumbData = await ff.readFile(thumbName);
      const mp4 = mp4Data instanceof Uint8Array ? mp4Data : new TextEncoder().encode(String(mp4Data));
      const thumb = thumbData instanceof Uint8Array ? thumbData : new TextEncoder().encode(String(thumbData));

      results.push({
        index: i + 1,
        startSeconds: w.start,
        endSeconds: w.end,
        mp4,
        thumbnailJpg: thumb,
        title: `Clip ${i + 1} · ${Math.round(w.start)}s–${Math.round(w.end)}s · ${usedTarget.h}p`,
      });

      try { await ff.deleteFile(clipName); } catch {}
      try { await ff.deleteFile(thumbName); } catch {}
    }
  } finally {
    ff.off("progress", onProgress);
    try { await ff.deleteFile(inputName); } catch {}
  }

  notify({ stage: "done", percent: 100, clipPercent: 100, message: `Generated ${results.length} clip${results.length === 1 ? "" : "s"}.` });
  return results;
}
