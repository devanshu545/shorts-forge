// Browser-side long-video splitter using ffmpeg.wasm. Runs entirely in the
// user's tab — no GitHub Actions, no server worker.
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { ClipProgress, ClipResult, SplitOptions } from "./ffmpeg-splitter.types";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegInstance: FFmpeg | null = null;

async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  const ff = new FFmpeg();
  if (onLog) ff.on("log", ({ message }) => onLog(message));
  await ff.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  });
  ffmpegInstance = ff;
  return ff;
}

function parseDurationFromLog(log: string): number | null {
  const m = log.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
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

export async function splitVideoInBrowser(file: File, opts: SplitOptions): Promise<ClipResult[]> {
  const target = opts.resolution === "4k"
    ? { w: 2160, h: 3840, bitrate: "24M" }
    : { w: 1080, h: 1920, bitrate: "12M" };

  let latestLog = "";
  let duration = 0;
  let currentClipDuration = 0;

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

  notify({ stage: "loading-ffmpeg", message: "Loading ffmpeg engine (first time only)…" });
  const ff = await getFFmpeg((line) => {
    latestLog = line;
    const dur = parseDurationFromLog(line);
    if (dur && !duration) duration = dur;
  });

  notify({ stage: "reading-file", message: "Reading uploaded video…" });
  const inputName = "input.mp4";
  await ff.writeFile(inputName, await fetchFile(file));

  notify({ stage: "probing", message: "Probing duration…" });
  // Run a null encode to get duration into logs.
  try {
    await ff.exec(["-i", inputName]);
  } catch {
    // -i alone exits non-zero; we only need the log parse.
  }
  if (!duration) {
    // Fallback: use metadata via ffprobe-style
    duration = 60; // safest default
  }

  const windows = pickWindows(duration, opts.clipLength, opts.maxClips);
  const total = windows.length;
  const startedAt = Date.now();
  const results: ClipResult[] = [];

  // ffmpeg.wasm progress event — reflects current exec.
  const onProgress = ({ progress, time }: { progress: number; time: number }) => {
    const clipPct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const fps = time > 0 && currentClipDuration > 0
      ? Number((((time / 1_000_000) / Math.max(elapsedSec, 0.5)) * 30).toFixed(1))
      : null;
    const overallDone = results.length + progress;
    const percent = Math.round((overallDone / Math.max(total, 1)) * 100);
    const eta = percent > 5 ? Math.round((elapsedSec / percent) * (100 - percent)) : null;
    notify({
      index: results.length + 1,
      total,
      stage: "encoding",
      percent,
      clipPercent: clipPct,
      etaSeconds: eta,
      fps,
      uploadMBps: null,
      message: `Encoding clip ${results.length + 1} of ${total} (${clipPct}%) — ${target.w}×${target.h}`,
    });
  };
  ff.on("progress", onProgress);

  try {
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      currentClipDuration = w.end - w.start;
      const clipName = `clip${i + 1}.mp4`;
      const thumbName = `thumb${i + 1}.jpg`;

      const vf = [
        `scale=${target.w}:${target.h}:force_original_aspect_ratio=increase`,
        `crop=${target.w}:${target.h}`,
        "unsharp=5:5:1.0:5:5:0.0",
        "fps=30",
      ].join(",");

      await ff.exec([
        "-y",
        "-ss", String(w.start),
        "-i", inputName,
        "-t", currentClipDuration.toFixed(2),
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-b:v", target.bitrate,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        clipName,
      ]);

      // Thumbnail from middle of clip.
      const mid = (currentClipDuration / 2).toFixed(2);
      await ff.exec([
        "-y",
        "-ss", mid,
        "-i", clipName,
        "-vframes", "1",
        "-vf", "scale=720:1280",
        "-q:v", "3",
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
        title: `Clip ${i + 1} · ${Math.round(w.start)}s–${Math.round(w.end)}s`,
      });

      try { await ff.deleteFile(clipName); } catch {}
      try { await ff.deleteFile(thumbName); } catch {}
    }
  } finally {
    ff.off("progress", onProgress);
    try { await ff.deleteFile(inputName); } catch {}
  }

  notify({ stage: "done", percent: 100, clipPercent: 100, message: `Generated ${results.length} clip${results.length === 1 ? "" : "s"}.` });
  // Silence unused variable lint
  void latestLog;
  return results;
}
