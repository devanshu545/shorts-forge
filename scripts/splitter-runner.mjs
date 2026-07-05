// Splitter runner — polls /api/public/splitter/tick for the next queued long
// video, downloads it, uses ffmpeg scene detection to pick the best moments,
// renders each to centered 9:16 with a blurred moving background and POSTs each clip back to
// /api/public/splitter/complete. When done, calls /finish to mark the job.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE = "https://devanshuautomation.lovable.app";
const BASE = (process.env.APP_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
const SECRET = process.env.AUTOPILOT_SECRET;
const EXPLICIT_ID = process.env.LONG_VIDEO_ID || "";
const UPSCALE_CLIP_ID = process.env.CLIP_ID || "";
const WORKER_ID = process.env.GITHUB_RUN_ID ? `github-${process.env.GITHUB_RUN_ID}` : `local-${Date.now()}`;

async function getOidc() {
  const u = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const t = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!u || !t) return null;
  const sep = u.includes("?") ? "&" : "?";
  const res = await fetch(`${u}${sep}audience=shortforge-autopilot`, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`OIDC token failed HTTP ${res.status}`);
  const b = await res.json();
  return typeof b.value === "string" ? b.value : null;
}
async function headers(extra = {}) {
  const h = { "x-worker-run-id": WORKER_ID, ...extra };
  const t = await getOidc();
  if (t) h.Authorization = `Bearer ${t}`;
  if (SECRET) h["x-autopilot-secret"] = SECRET;
  return h;
}
async function fetchWithTimeout(url, init = {}, timeoutMs = 120_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
async function retry(label, fn, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try { return await fn(i); }
    catch (err) {
      last = err;
      if (i >= attempts) break;
      console.warn(`${label} attempt ${i} failed: ${err instanceof Error ? err.message : err}`);
      await new Promise((resolve) => setTimeout(resolve, 800 * i));
    }
  }
  throw last;
}
function run(cmd, args, timeoutMs = 20 * 60 * 1000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", timeout: timeoutMs });
  if (r.error) throw new Error(`${cmd} ${args.slice(0,3).join(" ")} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0,3).join(" ")} failed: ${(r.stderr || r.stdout).slice(-1200)}`);
  return r.stdout;
}
function verticalBlurFilter(w, h, blur = 24) {
  return [
    "split=2[bg][fg]",
    `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},boxblur=${blur}:1[bg2]`,
    `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[fg2]`,
    "[bg2][fg2]overlay=(W-w)/2:(H-h)/2:format=auto",
  ].join(";");
}
function probeDuration(p) {
  const s = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", p]).trim();
  return Number(s) || 0;
}
function probeVideoMeta(p) {
  const out = run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    p,
  ]);
  const json = JSON.parse(out);
  const stream = json.streams?.[0] || {};
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    duration: Number(json.format?.duration) || 0,
  };
}
function assertShortsSafe(filePath, label) {
  const meta = probeVideoMeta(filePath);
  const ratio = meta.width / Math.max(meta.height, 1);
  if (!(meta.height > meta.width && Math.abs(ratio - 9 / 16) < 0.02)) {
    throw new Error(`${label} is not valid 9:16 Shorts format (${meta.width}x${meta.height})`);
  }
  if (meta.duration > 60.5) throw new Error(`${label} is too long for Shorts (${meta.duration.toFixed(1)}s)`);
  if (meta.duration <= 0) throw new Error(`${label} has no valid duration`);
  return meta;
}
function detectSceneStarts(p, thresh = 0.35) {
  try {
    const out = spawnSync("ffmpeg", ["-hide_banner", "-i", p, "-vf", `select='gt(scene,${thresh})',showinfo`, "-f", "null", "-"], { encoding: "utf8" });
    const stderr = out.stderr || "";
    const starts = [];
    const re = /pts_time:([\d.]+)/g;
    let m;
    while ((m = re.exec(stderr)) !== null) starts.push(Number(m[1]));
    return starts;
  } catch { return []; }
}
function pickWindows(duration, clipLen, maxClips, scenes) {
  const wins = [];
  const usable = Math.max(0, duration - 1);
  if (usable <= clipLen) {
    // Whole video becomes one clip
    return [{ start: 0, end: Math.min(duration, clipLen) }];
  }
  const candidates = scenes.length ? scenes.filter((t) => t + 8 < usable) : [];
  if (candidates.length >= 3) {
    // Space out picks so we don't cluster.
    const step = Math.max(1, Math.floor(candidates.length / maxClips));
    for (let i = 0; i < candidates.length && wins.length < maxClips; i += step) {
      const start = Math.max(0, candidates[i] - 0.5);
      const end = Math.min(duration, start + clipLen);
      if (end - start >= clipLen * 0.7) wins.push({ start, end });
    }
  }
  if (wins.length < Math.min(maxClips, 3)) {
    // Fallback: evenly spaced windows.
    const gap = usable / (maxClips + 1);
    wins.length = 0;
    for (let i = 1; i <= maxClips; i++) {
      const start = Math.max(0, i * gap - clipLen / 2);
      const end = Math.min(duration, start + clipLen);
      if (end - start >= 10) wins.push({ start, end });
    }
  }
  // De-duplicate overlapping windows.
  wins.sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of wins) {
    if (!out.length || w.start - out[out.length - 1].end > 2) out.push(w);
    if (out.length >= maxClips) break;
  }
  return out;
}

async function fetchJob() {
  const url = EXPLICIT_ID
    ? `${BASE}/api/public/splitter/tick?longVideoId=${EXPLICIT_ID}`
    : `${BASE}/api/public/splitter/tick`;
  const res = await fetchWithTimeout(url, { method: "POST", headers: await headers({ "Content-Type": "application/json" }) }, 45_000);
  const text = await res.text();
  if (!res.ok) throw new Error(`tick failed HTTP ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  return json.job;
}

async function fetchUpscaleJob() {
  const res = await fetchWithTimeout(`${BASE}/api/public/splitter/upscale-tick?clipId=${UPSCALE_CLIP_ID}`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
  }, 45_000);
  const text = await res.text();
  if (!res.ok) throw new Error(`upscale tick failed HTTP ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  return json.job;
}

async function uploadSigned(uploadUrl, filePath, contentType) {
  const bytes = readFileSync(filePath);
  return retry(`signed upload ${filePath}`, async () => {
    const payload = new FormData();
    payload.append("cacheControl", "3600");
    payload.append("", new Blob([bytes], { type: contentType }));
    const res = await fetchWithTimeout(uploadUrl, { method: "PUT", body: payload, headers: { "x-upsert": "true" } }, 8 * 60 * 1000);
    const text = await res.text();
    if (!res.ok) throw new Error(`signed upload failed HTTP ${res.status}: ${text.slice(0, 500)}`);
    return bytes.length;
  }, 3);
}

async function prepareClipUpload(job, index) {
  const res = await fetchWithTimeout(`${BASE}/api/public/splitter/prepare-clip-upload`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ longVideoId: job.longVideoId, userId: job.userId, index }),
  }, 45_000);
  const text = await res.text();
  if (!res.ok) throw new Error(`prepare clip upload HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function reportSplitProgress(job, progress, stage, detail = {}) {
  await fetchWithTimeout(`${BASE}/api/public/splitter/progress`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ longVideoId: job.longVideoId, userId: job.userId, progress, stage, workerId: WORKER_ID, detail }),
  }, 20_000).catch(() => {});
}

async function reportUpscaleProgress(clipId, progress, stage) {
  await fetchWithTimeout(`${BASE}/api/public/splitter/upscale-progress`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ clipId, progress, stage }),
  }, 20_000).catch(() => {});
}

async function processUpscaleJob(job) {
  const workDir = join(tmpdir(), `upscale-${job.clipId}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const src = join(workDir, "clip-source.mp4");
  const out = join(workDir, "clip-4k.mp4");
  console.log(`Downloading HD clip (${job.sourceUrl.slice(0, 90)}…)`);
  const dl = await retry("download 4K source clip", () => fetchWithTimeout(job.sourceUrl, {}, 4 * 60 * 1000), 3);
  if (!dl.ok) throw new Error(`Clip download failed HTTP ${dl.status}`);
  writeFileSync(src, Buffer.from(await dl.arrayBuffer()));
  await reportUpscaleProgress(job.clipId, 30, "Native 4K source downloaded");

  const dur = probeDuration(src);
  if (dur <= 0) throw new Error("Could not probe clip duration");
  console.log(`Native 4K upscale: ${dur.toFixed(1)}s clip`);
  await reportUpscaleProgress(job.clipId, 42, "Native 4K render started");

  const vf = [
    verticalBlurFilter(2160, 3840, 28),
    "eq=saturation=1.08:contrast=1.035:brightness=0.005",
    "unsharp=5:5:0.85:5:5:0.0",
  ].join(",");
  run("ffmpeg", [
    "-y", "-i", src,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-maxrate", "32M", "-bufsize", "48M",
    "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    "-af", "acompressor=threshold=-18dB:ratio=2.1:attack=12:release=120,alimiter=limit=0.96",
    "-movflags", "+faststart", out,
  ]);
  assertShortsSafe(out, "4K upgraded clip");
  await reportUpscaleProgress(job.clipId, 82, "Native 4K render finished; uploading");

  const size = await uploadSigned(job.uploadSignedUrl, out, "video/mp4");
  await reportUpscaleProgress(job.clipId, 94, "Native 4K upload finished; finalizing");
  const res = await fetchWithTimeout(`${BASE}/api/public/splitter/upscale-complete`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ clipId: job.clipId, fileSizeBytes: size, durationSeconds: dur }),
  }, 45_000);
  const text = await res.text();
  if (!res.ok) throw new Error(`upscale complete HTTP ${res.status}: ${text.slice(0, 500)}`);
  rmSync(workDir, { recursive: true, force: true });
}

async function processJob(job) {
  const workDir = join(tmpdir(), `split-${job.longVideoId}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const src = join(workDir, "source.mp4");
  console.log(`Downloading source (${job.sourceUrl.slice(0, 90)}…)`);
  await reportSplitProgress(job, 18, "Downloading source video");
  const dl = await retry("download source", () => fetchWithTimeout(job.sourceUrl, {}, 8 * 60 * 1000), 3);
  if (!dl.ok) throw new Error(`Source download failed HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  writeFileSync(src, buf);
  console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  const dur = probeDuration(src);
  if (dur <= 0) throw new Error("Could not probe source duration");
  console.log(`Duration: ${dur.toFixed(1)}s`);
  await reportSplitProgress(job, 24, "Source downloaded and metadata verified", { durationSeconds: dur });

  const scenes = detectSceneStarts(src, 0.35);
  console.log(`Detected ${scenes.length} scene changes`);
  const windows = pickWindows(dur, job.clipLength, job.maxClips, scenes);
  console.log(`Producing ${windows.length} clips`);
  if (!windows.length) throw new Error("No usable clip windows could be selected from this video");
  await reportSplitProgress(job, 30, `Selected ${windows.length} Shorts moments`, { scenes: scenes.length, clips: windows.length });

  let idx = 0;
  for (const w of windows) {
    idx += 1;
    const out = join(workDir, `clip${idx}.mp4`);
    const thumb = join(workDir, `thumb${idx}.jpg`);
    const clipDur = (w.end - w.start).toFixed(2);
    console.log(`  · clip ${idx}: ${w.start.toFixed(1)} → ${w.end.toFixed(1)} (${clipDur}s)`);
    const baseProgress = 30 + Math.round(((idx - 1) / windows.length) * 55);
    await reportSplitProgress(job, baseProgress, `Rendering clip ${idx} of ${windows.length}`);
    const fadeOut = Math.max(Number(clipDur) - 0.45, 0.1).toFixed(2);
    const vf = [
      verticalBlurFilter(1080, 1920),
      "fps=30",
      "eq=saturation=1.16:contrast=1.055:brightness=0.012",
      "unsharp=3:3:0.72:3:3:0.0",
      "vignette=PI/7:eval=init",
      "fade=t=in:st=0:d=0.18",
      `fade=t=out:st=${fadeOut}:d=0.35`,
    ].join(",");
    run("ffmpeg", [
      "-y", "-fflags", "+genpts+igndts+discardcorrupt", "-err_detect", "ignore_err",
      "-ss", String(w.start), "-i", src, "-t", clipDur,
      "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-max_muxing_queue_size", "4096",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-af", `acompressor=threshold=-18dB:ratio=2.1:attack=12:release=120,alimiter=limit=0.96,afade=t=in:st=0:d=0.12,afade=t=out:st=${fadeOut}:d=0.35`,
      "-movflags", "+faststart", "-shortest", out,
    ], 18 * 60 * 1000);
    const meta = assertShortsSafe(out, `clip ${idx}`);
    // Thumbnail from middle of clip.
    const mid = ((w.end - w.start) / 2).toFixed(2);
    run("ffmpeg", ["-y", "-ss", mid, "-i", out, "-vframes", "1", "-vf", "scale=720:1280", "-q:v", "3", thumb]);
    const prepared = await prepareClipUpload(job, idx);
    await reportSplitProgress(job, Math.min(90, baseProgress + 8), `Uploading clip ${idx} of ${windows.length}`);
    const fileSizeBytes = await uploadSigned(prepared.videoSignedUrl, out, "video/mp4");
    await uploadSigned(prepared.thumbnailSignedUrl, thumb, "image/jpeg");
    const title = `Clip ${idx} · ${Math.round(w.start)}s–${Math.round(w.end)}s`;
    const res = await fetchWithTimeout(`${BASE}/api/public/splitter/complete`, {
      method: "POST",
      headers: await headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        longVideoId: job.longVideoId,
        userId: job.userId,
        index: idx,
        startSeconds: w.start,
        endSeconds: w.end,
        videoStoragePath: prepared.videoPath,
        thumbnailStoragePath: prepared.thumbnailPath,
        fileSizeBytes,
        title,
        description: `Auto-cut from long-form video (${Math.round(w.start)}s–${Math.round(w.end)}s).\n\n#shorts #shortsfeed`,
        tags: ["shorts", "shorts fyp", "clip", "highlight"],
        durationSeconds: meta.duration || (w.end - w.start),
      }),
    }, 60_000);
    const t = await res.text();
    if (!res.ok) throw new Error(`complete[${idx}] HTTP ${res.status}: ${t.slice(0, 400)}`);
    console.log(`    ✅ uploaded clip ${idx}`);
    await reportSplitProgress(job, Math.min(95, 30 + Math.round((idx / windows.length) * 60)), `Clip ${idx} saved`);
  }

  const finish = await fetchWithTimeout(`${BASE}/api/public/splitter/finish`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ longVideoId: job.longVideoId, status: "ready", durationSeconds: dur }),
  }, 45_000);
  const finishText = await finish.text();
  if (!finish.ok) throw new Error(`finish HTTP ${finish.status}: ${finishText.slice(0, 500)}`);
  rmSync(workDir, { recursive: true, force: true });
}

async function main() {
  console.log(`Splitter runner starting @ ${BASE}`);
  if (UPSCALE_CLIP_ID) {
    const job = await fetchUpscaleJob();
    if (!job) { console.log("No clip to upscale. Done."); return; }
    try {
      await processUpscaleJob(job);
      console.log("✅ 4K upgrade done.");
    } catch (err) {
      console.error("FATAL:", err);
      try {
        await fetchWithTimeout(`${BASE}/api/public/splitter/upscale-complete`, {
          method: "POST",
          headers: await headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ clipId: UPSCALE_CLIP_ID, errorMessage: String(err instanceof Error ? err.message : err).slice(0, 1000) }),
        }, 30_000);
      } catch {}
      process.exit(1);
    }
    return;
  }
  const job = await fetchJob();
  if (!job) { console.log("No queued long videos. Done."); return; }
  console.log(`Job: ${job.longVideoId} (user ${job.userId.slice(0, 8)})`);
  try {
    await processJob(job);
    console.log("✅ Done.");
  } catch (err) {
    console.error("FATAL:", err);
    try {
      await fetchWithTimeout(`${BASE}/api/public/splitter/finish`, {
        method: "POST",
        headers: await headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ longVideoId: job.longVideoId, status: "failed_retryable", errorMessage: String(err instanceof Error ? err.message : err).slice(0, 1000) }),
      }, 30_000);
    } catch {}
    process.exit(1);
  }
}
main();
