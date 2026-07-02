// GitHub Actions runner: fetch due jobs, render with ffmpeg, POST back for upload.
// No npm deps — pure Node + system ffmpeg.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE = "https://devanshuautomation.lovable.app";
let configuredBase = process.env.APP_BASE_URL || DEFAULT_BASE;
if (configuredBase.includes("id-preview--")) {
  console.warn("APP_BASE_URL is a login-protected preview URL. Using the published URL for GitHub automation.");
  configuredBase = DEFAULT_BASE;
}
const BASE = configuredBase.replace(/\/+$/, "");
const SECRET = process.env.AUTOPILOT_SECRET;
if (!SECRET) { console.error("AUTOPILOT_SECRET missing"); process.exit(1); }
const FORCE = process.env.AUTOPILOT_FORCE === "1" || process.argv.includes("--force");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

function b64ToFile(b64, path) { writeFileSync(path, Buffer.from(b64, "base64")); }

function probeDuration(path) {
  const out = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
  return Math.max(2.5, Math.min(9, Number(out.trim()) || 5));
}

async function processJob(job) {
  const workDir = join(tmpdir(), `sf-${job.videoId}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  // Write assets
  const scenes = [];
  for (let i = 0; i < 4; i++) {
    const img = join(workDir, `img${i}.jpg`);
    const aud = join(workDir, `aud${i}.mp3`);
    b64ToFile(job.images[i], img);
    b64ToFile(job.audios[i], aud);
    const dur = probeDuration(aud);
    scenes.push({ img, aud, dur });
  }

  // Build per-scene video clips with Ken Burns via zoompan
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const { img, dur } = scenes[i];
    const out = join(workDir, `clip${i}.mp4`);
    const frames = Math.round(dur * 30);
    const zoomExpr = i % 2 === 0
      ? `zoompan=z='min(zoom+0.0015,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=30`
      : `zoompan=z='if(lte(zoom,1.0),1.25,max(1.001,zoom-0.0015))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=30`;
    run("ffmpeg", ["-y", "-loop", "1", "-i", img, "-t", String(dur), "-vf", zoomExpr, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", out]);
    clips.push({ out, dur });
  }

  // Concat clips (video only)
  const listFile = join(workDir, "list.txt");
  writeFileSync(listFile, clips.map((c) => `file '${c.out}'`).join("\n"));
  const videoConcat = join(workDir, "video.mp4");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", videoConcat]);

  // Concat audio
  const audioList = join(workDir, "audio-list.txt");
  writeFileSync(audioList, scenes.map((s) => `file '${s.aud}'`).join("\n"));
  const audioConcat = join(workDir, "audio.mp3");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", audioList, "-c", "copy", audioConcat]);

  // Overlay persistent "SUBSCRIBE" watermark and end-card, mux with audio
  const final = join(workDir, "final.mp4");
  const totalDur = scenes.reduce((s, c) => s + c.dur, 0);
  const endStart = Math.max(0, totalDur - 2.2);
  const drawtext = [
    // small persistent watermark bottom-right
    `drawtext=text='SUBSCRIBE':fontcolor=yellow:fontsize=28:box=1:boxcolor=black@0.55:boxborderw=8:x=w-tw-28:y=h-th-40:alpha=0.85`,
    // end card top
    `drawtext=text='Sub for part 2':fontcolor=white:fontsize=56:box=1:boxcolor=red@0.85:boxborderw=18:x=(w-tw)/2:y=140:enable='gte(t,${endStart})'`,
    // end card bottom big SUBSCRIBE
    `drawtext=text='SUBSCRIBE':fontcolor=black:fontsize=110:box=1:boxcolor=yellow@0.95:boxborderw=24:x=(w-tw)/2:y=h-th-200:enable='gte(t,${endStart})'`,
  ].join(",");
  run("ffmpeg", ["-y", "-i", videoConcat, "-i", audioConcat, "-vf", drawtext, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-shortest", "-pix_fmt", "yuv420p", final]);

  // Thumbnail = scene 4 image with a big overlay
  const thumb = join(workDir, "thumb.jpg");
  const title = (job.plan.title || "Watch this!").replace(/'/g, "");
  const thumbText = title.split(" ").slice(0, 4).join(" ").toUpperCase();
  run("ffmpeg", ["-y", "-i", scenes[3].img, "-vf",
    `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,drawtext=text='${thumbText}':fontcolor=white:fontsize=90:box=1:boxcolor=red@0.9:boxborderw=20:x=(w-tw)/2:y=h-th-60`,
    "-q:v", "3", thumb]);

  const mp4Base64 = readFileSync(final).toString("base64");
  const thumbnailBase64 = readFileSync(thumb).toString("base64");

  // Build SEO description
  const hashtags = (job.plan.hashtags || []).slice(0, 8).join(" ");
  const description = [
    `${job.plan.hook || job.plan.title}`,
    "",
    job.plan.description || "",
    "",
    "🔔 Subscribe for part 2!",
    "",
    hashtags,
    "#shorts #animation #storytime",
  ].filter(Boolean).join("\n");

  const tags = Array.from(new Set([
    ...(job.plan.hashtags || []).map((h) => h.replace(/^#/, "")),
    "shorts", "animation", "story", "cute", "funny", "kids", "storytime", "pixar style", "3d animation",
    ...(job.rawTopic || "").toLowerCase().split(/\s+/).slice(0, 5),
  ])).filter((t) => t && t.length > 1).slice(0, 20);

  const uploadRes = await fetch(`${BASE}/api/public/autopilot/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-autopilot-secret": SECRET },
    body: JSON.stringify({
      videoId: job.videoId,
      userId: job.userId,
      mp4Base64,
      thumbnailBase64,
      title: (job.plan.title || "New Short").slice(0, 100),
      description,
      tags,
      privacy: job.privacy,
      durationSeconds: totalDur,
    }),
  });
  const uploadText = await uploadRes.text();
  let json;
  try { json = JSON.parse(uploadText); }
  catch { throw new Error(`Upload returned non-JSON (${uploadRes.status}): ${uploadText.slice(0, 500)}`); }
  if (!uploadRes.ok || json?.ok === false) {
    throw new Error(`Upload failed (${uploadRes.status}): ${json?.error || uploadText.slice(0, 500)}`);
  }
  console.log(`[job ${job.videoId}] upload result:`, json);
  rmSync(workDir, { recursive: true, force: true });
}

async function main() {
  console.log(`Fetching autopilot jobs from ${BASE}...`);
  if (FORCE) {
    console.log("Manual test mode: uploading the latest ready Test Flow video. No new generation will run.");
    const runRes = await fetch(`${BASE}/api/public/autopilot/run-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-autopilot-secret": SECRET },
      body: JSON.stringify({ privacy: "public" }),
    });
    const runText = await runRes.text();
    let runJson;
    try { runJson = JSON.parse(runText); }
    catch { throw new Error(`Run workflow returned non-JSON (${runRes.status}): ${runText.slice(0, 1000)}`); }
    if (!runRes.ok || runJson?.ok === false) {
      console.error(`Run workflow failed HTTP ${runRes.status}`);
      console.error(`Response body: ${runText.slice(0, 2000)}`);
      if (runRes.status === 401) console.error("Fix: GitHub AUTOPILOT_SECRET does not match the app secret.");
      throw new Error(runJson?.error || `Run workflow failed ${runRes.status}`);
    }
    console.log(`✅ Uploaded to YouTube! Video ID: ${runJson.youtubeVideoId}`);
    console.log(`View on YouTube: ${runJson.youtubeUrl}`);
    return;
  }

  console.log("Scheduled mode: checking due upload slots.");
  const endpoint = `${BASE}/api/public/autopilot/tick?limit=5`;
  const tickRes = await fetch(endpoint, {
    method: "POST",
    headers: { "x-autopilot-secret": SECRET },
  });
  const tickText = await tickRes.text();
  if (!tickRes.ok) {
    console.error(`Tick failed HTTP ${tickRes.status}`);
    console.error(`Response body: ${tickText.slice(0, 2000)}`);
    if (tickRes.status === 401) {
      console.error("Fix: GitHub AUTOPILOT_SECRET does not match the app secret, or the app secret is missing.");
    }
    if (tickText.trim().startsWith("<")) {
      console.error("Fix: APP_BASE_URL is pointing to the wrong site. Use the published Lovable URL only, with no path.");
    }
    throw new Error(`Tick failed ${tickRes.status}`);
  }
  let parsed;
  try { parsed = JSON.parse(tickText); }
  catch { console.error("Tick returned non-JSON:", tickText.slice(0, 500)); throw new Error("Tick non-JSON"); }
  const jobs = parsed.jobs || [];
  const errors = parsed.errors || [];
  console.log(`Got ${jobs.length} jobs`);
  if (errors.length) console.error("Autopilot tick errors:", JSON.stringify(errors, null, 2));
  if (jobs.length === 0) {
    if (FORCE) {
      throw new Error(errors.length ? "Manual test could not create a job. See errors above." : "Manual test found no autopilot settings. Open Autopilot, turn it on, and click Apply.");
    }
    console.log("No jobs due right now. This is normal if no autopilot slot matches the current hour.");
    console.log("For an immediate test, run this workflow manually with force_test=true.");
  }
  let failed = 0;
  for (const job of jobs) {
    try { await processJob(job); }
    catch (err) { failed += 1; console.error(`Job ${job.videoId} failed:`, err); }
  }
  if (failed > 0) throw new Error(`${failed}/${jobs.length} autopilot job(s) failed.`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

