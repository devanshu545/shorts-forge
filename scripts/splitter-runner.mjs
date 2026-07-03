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
  const h = { ...extra };
  const t = await getOidc();
  if (t) h.Authorization = `Bearer ${t}`;
  if (SECRET) h["x-autopilot-secret"] = SECRET;
  return h;
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0,3).join(" ")} failed: ${(r.stderr || r.stdout).slice(-800)}`);
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
  const res = await fetch(url, { method: "POST", headers: await headers({ "Content-Type": "application/json" }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`tick failed HTTP ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  return json.job;
}

async function fetchUpscaleJob() {
  const res = await fetch(`${BASE}/api/public/splitter/upscale-tick?clipId=${UPSCALE_CLIP_ID}`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upscale tick failed HTTP ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  return json.job;
}

async function uploadSigned(uploadUrl, filePath, contentType) {
  const bytes = readFileSync(filePath);
  const payload = new FormData();
  payload.append("cacheControl", "3600");
  payload.append("", new Blob([bytes], { type: contentType }));
  const res = await fetch(uploadUrl, { method: "PUT", body: payload, headers: { "x-upsert": "true" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`signed upload failed HTTP ${res.status}: ${text.slice(0, 500)}`);
  return bytes.length;
}

async function reportUpscaleProgress(clipId, progress, stage) {
  await fetch(`${BASE}/api/public/splitter/upscale-progress`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ clipId, progress, stage }),
  }).catch(() => {});
}

async function processUpscaleJob(job) {
  const workDir = join(tmpdir(), `upscale-${job.clipId}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const src = join(workDir, "clip-source.mp4");
  const out = join(workDir, "clip-4k.mp4");
  console.log(`Downloading HD clip (${job.sourceUrl.slice(0, 90)}…)`);
  const dl = await fetch(job.sourceUrl);
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
  await reportUpscaleProgress(job.clipId, 82, "Native 4K render finished; uploading");

  const size = await uploadSigned(job.uploadSignedUrl, out, "video/mp4");
  await reportUpscaleProgress(job.clipId, 94, "Native 4K upload finished; finalizing");
  const res = await fetch(`${BASE}/api/public/splitter/upscale-complete`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ clipId: job.clipId, fileSizeBytes: size, durationSeconds: dur }),
  });
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
  const dl = await fetch(job.sourceUrl);
  if (!dl.ok) throw new Error(`Source download failed HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  writeFileSync(src, buf);
  console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  const dur = probeDuration(src);
  if (dur <= 0) throw new Error("Could not probe source duration");
  console.log(`Duration: ${dur.toFixed(1)}s`);

  const scenes = detectSceneStarts(src, 0.35);
  console.log(`Detected ${scenes.length} scene changes`);
  const windows = pickWindows(dur, job.clipLength, job.maxClips, scenes);
  console.log(`Producing ${windows.length} clips`);

  let idx = 0;
  for (const w of windows) {
    idx += 1;
    const out = join(workDir, `clip${idx}.mp4`);
    const thumb = join(workDir, `thumb${idx}.jpg`);
    const clipDur = (w.end - w.start).toFixed(2);
    console.log(`  · clip ${idx}: ${w.start.toFixed(1)} → ${w.end.toFixed(1)} (${clipDur}s)`);
    run("ffmpeg", [
      "-y", "-ss", String(w.start), "-i", src, "-t", clipDur,
      "-vf", `${verticalBlurFilter(1080, 1920)},fps=30`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
    ]);
    // Thumbnail from middle of clip.
    const mid = ((w.end - w.start) / 2).toFixed(2);
    run("ffmpeg", ["-y", "-ss", mid, "-i", out, "-vframes", "1", "-vf", "scale=720:1280", "-q:v", "3", thumb]);
    const mp4Base64 = readFileSync(out).toString("base64");
    const thumbnailBase64 = readFileSync(thumb).toString("base64");
    const title = `Clip ${idx} · ${Math.round(w.start)}s–${Math.round(w.end)}s`;
    const res = await fetch(`${BASE}/api/public/splitter/complete`, {
      method: "POST",
      headers: await headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        longVideoId: job.longVideoId,
        userId: job.userId,
        index: idx,
        startSeconds: w.start,
        endSeconds: w.end,
        mp4Base64,
        thumbnailBase64,
        title,
        description: `Auto-cut from long-form video (${Math.round(w.start)}s–${Math.round(w.end)}s).\n\n#shorts #shortsfeed`,
        tags: ["shorts", "shorts fyp", "clip", "highlight"],
        durationSeconds: w.end - w.start,
      }),
    });
    const t = await res.text();
    if (!res.ok) throw new Error(`complete[${idx}] HTTP ${res.status}: ${t.slice(0, 400)}`);
    console.log(`    ✅ uploaded clip ${idx}`);
  }

  await fetch(`${BASE}/api/public/splitter/finish`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ longVideoId: job.longVideoId, status: "ready", durationSeconds: dur }),
  });
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
        await fetch(`${BASE}/api/public/splitter/upscale-complete`, {
          method: "POST",
          headers: await headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ clipId: UPSCALE_CLIP_ID, errorMessage: String(err instanceof Error ? err.message : err).slice(0, 1000) }),
        });
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
      await fetch(`${BASE}/api/public/splitter/finish`, {
        method: "POST",
        headers: await headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ longVideoId: job.longVideoId, status: "failed", errorMessage: String(err instanceof Error ? err.message : err).slice(0, 1000) }),
      });
    } catch {}
    process.exit(1);
  }
}
main();
