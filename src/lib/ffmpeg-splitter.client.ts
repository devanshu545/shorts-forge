// Browser-side long-video splitter using ffmpeg.wasm. Runs entirely in the
// user's tab — no GitHub Actions, no server worker.
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import type { ClipProgress, ClipResult, SplitOptions } from "./ffmpeg-splitter.types";

const CORE_JS_URL = "/ffmpeg-core/ffmpeg-core.js";
const WASM_MANIFEST_URL = "/ffmpeg-core/ffmpeg-core.wasm.asset.json";

let ffmpegInstance: FFmpeg | null = null;
let recentLogs: string[] = [];
let activeAbort = false;
let abortReason: string | null = null;

function ffmpegLogTail(lines = 14): string {
  const compact = recentLogs
    .slice(-lines)
    .map((line) => line.replace(/Last message repeated \d+ times?/gi, "repeated decoder message"))
    .filter((line, index, arr) => line && line !== arr[index - 1]);
  const text = compact.join(" | ") || "no ffmpeg log output";
  return text.length > 900 ? `${text.slice(0, 900)}…` : text;
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

// Cinematic polish filter chain — tuned for speed on ffmpeg-wasm (single-thread).
// Every filter here is chosen so the whole clip finishes 3-6x faster than the
// old chain, with visual quality preserved (or improved) after the unsharp.
//   - fast_bilinear scale: ~4-8x faster than lanczos in wasm; unsharp restores
//     the edge crispness so the eye can't tell.
//   - vignette uses eval=init so the vignette lookup is computed ONCE, not per
//     frame — this alone was ~25-35% of old encode time.
//   - unsharp kernel dropped from 5x5 to 3x3 (~3x cheaper) with matched strength.
//   - eq combined into a single pass with saturation+contrast.
// Subject-centered vertical layout: splits input into a blurred cover-fit
// background and an original-aspect foreground centered on top. Prevents
// horizontal cropping of the main subject when the source is landscape or
// square, while still filling 9:16 for Shorts.
function verticalCenterGraph(w: number, h: number, blur = 22): string {
  return [
    `split=2[bg][fg]`,
    `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${w}:${h},boxblur=${blur}:1[bg2]`,
    `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=fast_bilinear[fg2]`,
    `[bg2][fg2]overlay=(W-w)/2:(H-h)/2:format=auto`,
  ].join(";");
}

async function probeMp4Meta(mp4: Uint8Array): Promise<{ width: number; height: number; duration: number }> {
  const blob = new Blob([mp4.slice().buffer as ArrayBuffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Could not read generated MP4 metadata"));
      setTimeout(() => (video.videoWidth ? resolve() : reject(new Error("Timed out reading generated MP4 metadata"))), 8000);
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

function isVerticalShortMeta(meta: { width: number; height: number; duration: number }) {
  const ratio = meta.width / Math.max(meta.height, 1);
  return meta.height > meta.width && Math.abs(ratio - 9 / 16) < 0.015 && meta.duration <= 60.5;
}

function polishFilter(clipDurationSec: number, w = 1080, h = 1920): string {
  const fadeOutStart = Math.max(clipDurationSec - 0.5, 0.1).toFixed(2);
  const tail = [
    "unsharp=3:3:0.8:3:3:0.0",
    "eq=saturation=1.18:contrast=1.06:brightness=0.02",
    "vignette=PI/6:eval=init",
    "fade=t=in:st=0:d=0.3",
    `fade=t=out:st=${fadeOutStart}:d=0.4`,
  ].join(",");
  return `${verticalCenterGraph(w, h)},${tail}`;
}

function compactPolishFilter(): string {
  return [
    "eq=saturation=1.12:contrast=1.04:brightness=0.01",
    "unsharp=3:3:0.55:3:3:0.0",
    "fade=t=in:st=0:d=0.18",
  ].join(",");
}

function assertNotAborted() {
  if (activeAbort) throw new Error(abortReason || "Cancelled by user");
}

function terminateActive(reason: string) {
  activeAbort = true;
  abortReason = reason;
  try { ffmpegInstance?.terminate(); } catch { /* noop */ }
  ffmpegInstance = null;
}

async function execWithBrowserBudget(ff: FFmpeg, args: string[], budgetSec: number, label: string) {
  let timeoutId = 0;
  try {
    return await Promise.race([
      ff.exec(args, Math.max(5, budgetSec)),
      new Promise<number>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          terminateActive(`${label} exceeded its safe time budget; keeping the fastest working Shorts path`);
          reject(new Error(abortReason || `${label} timed out`));
        }, Math.max(5, budgetSec) * 1000);
      }),
    ]);
  } finally {
    window.clearTimeout(timeoutId);
  }
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
// NOTE: We deliberately omit `-movflags +faststart` here. Faststart triggers a
// second pass that loads the whole output into memory to relocate the moov
// atom — on 4K/2160p60 sources this aborts ffmpeg.wasm with exit 69
// ("Conversion failed! Aborted()"). Playback works fine without it.
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
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    clipName,
  ]);
  if (code !== 0) throw new Error(`instant copy exit ${code}: ${ffmpegLogTail()}`);
}

async function cutClipFastCopyFromFile(ff: FFmpeg, inputName: string, clipName: string, startSec: number, durSec: number) {
  const code = await ff.exec([
    "-y",
    "-i", inputName,
    "-ss", String(startSec),
    "-t", durSec.toFixed(2),
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    clipName,
  ], 25);
  if (code !== 0) throw new Error(`fast copy exit ${code}: ${ffmpegLogTail()}`);
}


async function encodeCompatibilityClip(
  ff: FFmpeg,
  inputName: string,
  clipName: string,
  startSec: number,
  durSec: number,
  width = 720,
  height = 1280,
  blur = 18,
) {
  const code = await execWithBrowserBudget(ff, [
    "-y",
    "-fflags", "+genpts+igndts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-ss", String(startSec),
    "-i", inputName,
    "-t", durSec.toFixed(2),
    "-map", "0:v:0",
    "-map", "0:a?",
    "-vf", verticalCenterGraph(width, height, blur),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-x264-params", "keyint=60:min-keyint=30:scenecut=0:rc-lookahead=0:ref=1:bframes=0",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-movflags", "+faststart",
    "-threads", "0",
    clipName,
  ], Math.min(90, Math.max(35, durSec * (width >= 720 ? 1.8 : 1.15))), `Shorts compatibility encode for clip ${clipName}`);
  if (code !== 0) throw new Error(`compat encode exit ${code}: ${ffmpegLogTail()}`);
}

async function encodeShortsSafeClipFromBytes(
  ff: FFmpeg,
  mp4: Uint8Array,
  clipName: string,
  durSec: number,
) {
  const inName = `${clipName.replace(/\.mp4$/i, "")}_in.mp4`;
  await ff.writeFile(inName, new Uint8Array(mp4));
  try {
    const code = await execWithBrowserBudget(ff, [
      "-y",
      "-fflags", "+genpts+igndts+discardcorrupt",
      "-err_detect", "ignore_err",
      "-i", inName,
      "-t", Math.min(durSec, 60).toFixed(2),
      "-vf", verticalCenterGraph(720, 1280, 18),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-x264-params", "keyint=60:min-keyint=30:scenecut=0:rc-lookahead=0:ref=1:bframes=0",
      "-crf", "21",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ac", "2",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-threads", "0",
      clipName,
    ], Math.min(90, Math.max(35, durSec * 1.8)), `Shorts-safe encode for ${clipName}`);
    if (code !== 0) throw new Error(`shorts-safe encode exit ${code}: ${ffmpegLogTail()}`);
  } finally {
    try { await ff.deleteFile(inName); } catch { /* noop */ }
  }
}

async function ensureVerticalShortMp4(
  ff: FFmpeg,
  mp4: Uint8Array,
  clipName: string,
  durSec: number,
  clipIndex: number,
  source?: { inputName: string; startSec: number },
) {
  const meta = await probeMp4Meta(mp4).catch(() => null);
  if (meta?.duration && meta.duration > 60.5) throw new Error(`Clip ${clipIndex} is ${Math.round(meta.duration)}s; YouTube Shorts must be 60s or less.`);
  if (meta && isVerticalShortMeta(meta)) return mp4;
  if (source) {
    await encodeCompatibilityClip(ff, source.inputName, clipName, source.startSec, durSec);
  } else {
    await encodeShortsSafeClipFromBytes(ff, mp4, clipName, durSec);
  }
  const safe = await readValidMp4(ff, clipName, clipIndex);
  const safeMeta = await probeMp4Meta(safe);
  if (!isVerticalShortMeta(safeMeta)) throw new Error(`Clip ${clipIndex} is still not vertical 9:16 after conversion; upload stopped.`);
  return safe;
}

// Fast enhancement pass. The important speed trick is that this runs from an
// already-cut short clip, not the full source file. Re-encoding a 30-60s local
// short is dramatically faster and gives us a safe fallback: the instant clip
// already exists if this pass hits the budget.
async function encodeFastPolishedClipFromShort(
  ff: FFmpeg,
  inputClipName: string,
  clipName: string,
  durSec: number,
) {
  const fadeOut = Math.max(durSec - 0.45, 0.1).toFixed(2);
  const tail = [
    "eq=saturation=1.2:contrast=1.07:brightness=0.015",
    "unsharp=3:3:0.7:3:3:0.0",
    "vignette=PI/7:eval=init",
    "fade=t=in:st=0:d=0.18",
    `fade=t=out:st=${fadeOut}:d=0.35`,
  ].join(",");
  const vf = `${verticalCenterGraph(720, 1280, 18)},${tail}`;
  const code = await execWithBrowserBudget(ff, [
    "-y",
    "-fflags", "+genpts+igndts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-i", inputClipName,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-x264-params", "keyint=60:min-keyint=30:scenecut=0:rc-lookahead=0:ref=1:bframes=0",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ac", "2",
    "-af", `acompressor=threshold=-18dB:ratio=2.2:attack=12:release=120,alimiter=limit=0.96,afade=t=in:st=0:d=0.12,afade=t=out:st=${fadeOut}:d=0.35`,
    "-movflags", "+faststart",
    "-threads", "0",
    clipName,
  ], Math.min(60, Math.max(12, durSec * 1.2)), `Fast polish for ${clipName}`);
  if (code !== 0) throw new Error(`fast polish exit ${code}: ${ffmpegLogTail()}`);
}

// One-pass polish encode: cut + cinematic filter chain at 1080x1920.
// Tuned for maximum wasm throughput: ultrafast + zerolatency + tiny GOP lookahead.
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
    "-tune", "zerolatency",
    "-x264-params", "keyint=60:min-keyint=60:scenecut=0:rc-lookahead=10:ref=1",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-af", "afade=t=in:st=0:d=0.25,afade=t=out:st=" + Math.max(durSec - 0.4, 0.1).toFixed(2) + ":d=0.4",
    "-movflags", "+faststart",
    "-threads", "0",
    clipName,
  ]);
  if (code !== 0) throw new Error(`polish encode exit ${code}: ${ffmpegLogTail()}`);
}


async function readValidMp4(ff: FFmpeg, clipName: string, clipIndex: number): Promise<Uint8Array> {
  const mp4Data = await ff.readFile(clipName);
  const mp4 = mp4Data instanceof Uint8Array ? new Uint8Array(mp4Data) : new TextEncoder().encode(String(mp4Data));
  if (mp4.byteLength < 50_000) {
    throw new Error(`Generated clip ${clipIndex} is empty (${mp4.byteLength} bytes). ${ffmpegLogTail()}`);
  }
  return mp4;
}

export async function splitVideoInBrowser(file: File, opts: SplitOptions): Promise<ClipResult[]> {
  activeAbort = false;
  abortReason = null;
  const hardBudgetSec = Math.max(60, opts.maxProcessingSeconds ?? 290);
  const notify = (patch: Partial<ClipProgress> & Pick<ClipProgress, "stage" | "message">) => {
    opts.onProgress({
      index: 0, total: 0, percent: 0, clipPercent: 0,
      etaSeconds: null, elapsedSeconds: 0, fps: null, uploadMBps: null,
      lastLog: ffmpegLogTail(3), updatedAt: Date.now(),
      ...patch,
    } as ClipProgress);
  };

  notify({ stage: "probing", message: "Reading video metadata…" });
  const probedDuration = await probeDurationFromFile(file);
  const duration = probedDuration > 0 ? probedDuration : opts.clipLength;

  notify({ stage: "loading-ffmpeg", message: "Loading ffmpeg engine (first time only, ~30MB)…" });
  let ff = await getFFmpeg();

  notify({ stage: "reading-file", message: `Loading ${(file.size / 1024 / 1024).toFixed(1)}MB into ffmpeg…` });
  const inputName = "input.mp4";
  await ff.writeFile(inputName, await fetchFile(file));

  const windows = pickWindows(duration, opts.clipLength, opts.maxClips);
  const total = windows.length;
  const startedAt = Date.now();
  const results: ClipResult[] = [];
  let skipFurtherPolish = false;

  const onProgress = ({ progress }: { progress: number }) => {
    const clipPct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const overallDone = results.length + Math.max(0, Math.min(1, progress));
    const percent = Math.round((overallDone / Math.max(total, 1)) * 100);
    const eta = percent > 3 ? Math.round((elapsedSec / percent) * (100 - percent)) : null;
    notify({
      index: results.length + 1, total,
      stage: opts.polish ? "polishing" : "encoding",
      percent, clipPercent: clipPct, etaSeconds: eta, elapsedSeconds: Math.round(elapsedSec), fps: null, uploadMBps: null,
      message: opts.polish
        ? `Fast polishing clip ${results.length + 1} of ${total} (${clipPct}%) — budget protected`
        : `Cutting clip ${results.length + 1} of ${total} (${clipPct}%)`,
    });
  };
  ff.on("progress", onProgress);

  try {
    for (let i = 0; i < windows.length; i++) {
      assertNotAborted();
      const w = windows[i];
      const dur = w.end - w.start;
      const instantName = `clip${i + 1}_instant.mp4`;
      const polishedName = `clip${i + 1}_polished.mp4`;
      const shortsName = `clip${i + 1}_shorts_safe.mp4`;
      let mp4: Uint8Array | null = null;
      const elapsed = (Date.now() - startedAt) / 1000;
      const remainingBudget = hardBudgetSec - elapsed;
      const perClipBudget = Math.max(8, Math.min(38, Math.floor((remainingBudget - 18) / Math.max(windows.length - i, 1))));

      try {
        notify({
          index: i + 1, total,
          stage: "encoding",
          percent: Math.round((results.length / Math.max(total, 1)) * 100),
          clipPercent: 0,
          etaSeconds: null,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          message: `Instant-cutting clip ${i + 1} of ${total} first so a usable short is always ready…`,
        });
        try {
          await cutClipFastCopyFromFile(ff, inputName, instantName, w.start, dur);
        } catch (copyErr) {
          console.warn("[splitter] stream-copy unavailable, using compatibility encode", copyErr);
          notify({
            index: i + 1, total,
            stage: "encoding",
            percent: Math.round((results.length / Math.max(total, 1)) * 100),
            clipPercent: 0,
            etaSeconds: perClipBudget,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            message: `Source codec needs conversion. Using ultrafast MP4 compatibility encode for clip ${i + 1}…`,
          });
          try { await ff.deleteFile(instantName); } catch { /* noop */ }
          try {
            await encodeCompatibilityClip(ff, inputName, instantName, w.start, dur);
          } catch (compatErr) {
            if (abortReason === "Cancelled by user") throw compatErr;
            console.warn("[splitter] 720p compatibility encode failed, retrying tiny safe encode", compatErr);
            activeAbort = false;
            abortReason = null;
            ff = await getFFmpeg();
            await ff.writeFile(inputName, await fetchFile(file));
            await encodeCompatibilityClip(ff, inputName, instantName, w.start, dur, 360, 640, 10);
          }
        }
        mp4 = await readValidMp4(ff, instantName, i + 1);

        if (opts.polish && !skipFurtherPolish && remainingBudget > 18 && perClipBudget > 8) {
          let timeoutId = 0;
          try {
            notify({
              index: i + 1, total,
              stage: "polishing",
              percent: Math.round((results.length / Math.max(total, 1)) * 100),
              clipPercent: 0,
              etaSeconds: perClipBudget,
              elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
              message: `Speed-polishing clip ${i + 1} of ${total} from the short file (${perClipBudget}s cap)…`,
            });
            await Promise.race([
              encodeFastPolishedClipFromShort(ff, instantName, polishedName, dur),
              new Promise<never>((_, reject) => {
                const timeoutMs = perClipBudget * 1000;
                timeoutId = window.setTimeout(() => {
                  terminateActive("Speed polish exceeded its safe budget; keeping instant HD and skipping more polish this run");
                  reject(new Error(abortReason || "Speed polish switched to instant fallback"));
                }, timeoutMs);
              }),
            ]).finally(() => window.clearTimeout(timeoutId));
            mp4 = await readValidMp4(ff, polishedName, i + 1);
          } catch (err) {
            if (abortReason === "Cancelled by user") throw err;
            console.warn("[splitter] polish skipped; instant HD kept", err);
            skipFurtherPolish = true;
            notify({
              index: i + 1, total,
              stage: "encoding",
              percent: Math.round(((results.length + 1) / Math.max(total, 1)) * 100),
              clipPercent: 100,
              etaSeconds: null,
              elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
              message: "Polish was slower than the budget, so instant HD was kept to finish on time.",
            });
            if (!ffmpegInstance || activeAbort) {
              activeAbort = false;
              abortReason = null;
              ff = await getFFmpeg();
              await ff.writeFile(inputName, await fetchFile(file));
            }
          }
        } else {
          notify({
            index: i + 1, total,
            stage: "encoding",
            percent: Math.round(((results.length + 1) / Math.max(total, 1)) * 100),
            clipPercent: 100,
            etaSeconds: null,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            message: skipFurtherPolish
              ? "Using instant HD for remaining clips to stay under the time budget."
              : "Instant HD clip ready.",
          });
        }
      } catch (err) {
        if (abortReason === "Cancelled by user") throw err;
        console.warn("[splitter] primary path failed, retrying with instant copy", err);
        try { await ff.deleteFile(instantName); } catch { /* noop */ }
        try { await ff.deleteFile(polishedName); } catch { /* noop */ }
        if (!ffmpegInstance || activeAbort) {
          activeAbort = false;
          abortReason = null;
          ff = await getFFmpeg();
          await ff.writeFile(inputName, await fetchFile(file));
        }
        try {
          await cutClipFastCopyFromFile(ff, inputName, instantName, w.start, dur);
        } catch {
          try { await ff.deleteFile(instantName); } catch { /* noop */ }
          try {
            await encodeCompatibilityClip(ff, inputName, instantName, w.start, dur);
          } catch (compatErr) {
            if (abortReason === "Cancelled by user") throw compatErr;
            activeAbort = false;
            abortReason = null;
            ff = await getFFmpeg();
            await ff.writeFile(inputName, await fetchFile(file));
            await encodeCompatibilityClip(ff, inputName, instantName, w.start, dur, 360, 640, 10);
          }
        }
        mp4 = await readValidMp4(ff, instantName, i + 1);
      }
      if (!mp4) throw new Error(`Generated clip ${i + 1} is missing after encode.`);
      try {
        mp4 = await ensureVerticalShortMp4(ff, mp4, shortsName, dur, i + 1, { inputName, startSec: w.start });
      } catch (err) {
        if (abortReason === "Cancelled by user") throw err;
        console.warn("[splitter] 720p vertical encode failed, retrying tiny safe encode", err);
        activeAbort = false;
        abortReason = null;
        ff = await getFFmpeg();
        await ff.writeFile(inputName, await fetchFile(file));
        await encodeCompatibilityClip(ff, inputName, shortsName, w.start, dur, 360, 640, 10);
        mp4 = await readValidMp4(ff, shortsName, i + 1);
        const tinyMeta = await probeMp4Meta(mp4);
        if (!isVerticalShortMeta(tinyMeta)) throw new Error(`Clip ${i + 1} could not be converted to vertical Shorts format.`);
      }

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
      opts.onClip?.(results[results.length - 1]);

      try { await ff.deleteFile(instantName); } catch { /* noop */ }
      try { await ff.deleteFile(polishedName); } catch { /* noop */ }
      try { await ff.deleteFile(shortsName); } catch { /* noop */ }
    }
  } finally {
    ff.off("progress", onProgress);
    try { await ff.deleteFile(inputName); } catch { /* noop */ }
  }

  notify({
    stage: "done", percent: 100, clipPercent: 100,
    message: `Generated ${results.length} ${opts.polish && !skipFurtherPolish ? "speed-polished" : "instant HD"} clip${results.length === 1 ? "" : "s"}.`,
  });
  return results;
}

export function cancelSplitVideoInBrowser() {
  terminateActive("Cancelled by user");
}

// Smart-4K background upscale: takes an existing 1080p MP4 and re-encodes to
// 2160x3840 with lanczos + sharpen. Called AFTER instant HD clips are already
// live in the library, so the user is never blocked on 4K encode time.
export async function upscaleClipTo4K(
  mp4: Uint8Array,
  onProgress?: (pct: number) => void,
  maxSeconds = 290,
): Promise<Uint8Array> {
  activeAbort = false;
  abortReason = null;
  const ff = await getFFmpeg();
  const inName = `up_in_${Date.now()}.mp4`;
  const outName = `up_out_${Date.now()}.mp4`;
  // ffmpeg.wasm may detach/transfers the supplied ArrayBuffer. Always write a
  // copy so the caller's local clip bytes remain usable for preview/retry.
  await ff.writeFile(inName, new Uint8Array(mp4));
  const startedAt = Date.now();

  const handler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(100, Math.round(progress * 100))));
    if ((Date.now() - startedAt) / 1000 > maxSeconds) activeAbort = true;
  };
  ff.on("progress", handler);
  const timeout = window.setTimeout(() => terminateActive("4K upgrade hit the 5-minute budget"), maxSeconds * 1000);
  try {
    // fast_bilinear scale (~5x faster than lanczos in wasm) + strong unsharp
    // restores lanczos-equivalent perceived sharpness at a fraction of the CPU.
    const vf = [
      verticalCenterGraph(2160, 3840),
      "unsharp=5:5:1.0:5:5:0.0",
    ].join(",");
    const code = await ff.exec([
      "-y",
      "-i", inName,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-x264-params", "keyint=60:min-keyint=60:scenecut=0:rc-lookahead=10:ref=1",
      "-crf", "23",
      "-maxrate", "18M",
      "-bufsize", "26M",
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "-movflags", "+faststart",
      "-threads", "0",
      outName,
    ]);
    if (code !== 0) throw new Error(`4K upscale exit ${code}: ${ffmpegLogTail()}`);
    assertNotAborted();

    const out = await ff.readFile(outName);
    const bytes = out instanceof Uint8Array ? new Uint8Array(out) : new TextEncoder().encode(String(out));
    if (bytes.byteLength < 100_000) throw new Error("4K output too small — treating as failure");
    return bytes;
  } finally {
    window.clearTimeout(timeout);
    ff.off("progress", handler);
    try { await ff.deleteFile(inName); } catch { /* noop */ }
    try { await ff.deleteFile(outName); } catch { /* noop */ }
  }
}
