// GitHub Actions runner: fetch due jobs, render premium-quality Short with ffmpeg, POST back for upload.
// No npm deps — pure Node + system ffmpeg. Bundled Anton font + synthesized music bed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const FONT_PATH = join(REPO_ROOT, "assets/fonts/Anton-Regular.ttf");
if (!existsSync(FONT_PATH)) throw new Error(`Missing display font at ${FONT_PATH}`);

const DEFAULT_BASE = "https://devanshuautomation.lovable.app";
let configuredBase = process.env.APP_BASE_URL || DEFAULT_BASE;
if (configuredBase.includes("id-preview--")) {
  console.warn("APP_BASE_URL is a login-protected preview URL. Using the published URL for GitHub automation.");
  configuredBase = DEFAULT_BASE;
}
const BASE = configuredBase.replace(/\/+$/, "");
const SECRET = process.env.AUTOPILOT_SECRET;
const FORCE = process.env.AUTOPILOT_FORCE === "1" || process.argv.includes("--force");
const CHANNEL_HANDLE = "@CraftWebStudio";

async function getGithubOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;
  const separator = requestUrl.includes("?") ? "&" : "?";
  const res = await fetch(`${requestUrl}${separator}audience=shortforge-autopilot`, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (!res.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${res.status}`);
  const body = await res.json();
  return typeof body.value === "string" ? body.value : null;
}

async function autopilotHeaders(extra = {}) {
  const headers = { ...extra };
  const oidcToken = await getGithubOidcToken();
  if (oidcToken) headers.Authorization = `Bearer ${oidcToken}`;
  if (SECRET) headers["x-autopilot-secret"] = SECRET;
  return headers;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${(r.stderr || r.stdout || "").slice(-1200)}`);
  return r.stdout;
}

function b64ToFile(b64, path) { writeFileSync(path, Buffer.from(b64, "base64")); }

function probeDuration(path) {
  const out = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
  return Math.max(2.5, Math.min(9, Number(out.trim()) || 5));
}

// ffmpeg drawtext escaping: single quotes and colons and backslashes are special.
function escDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019") // curly apostrophe — safest
    .replace(/[\r\n]+/g, " ");
}

// Split a voiceover string into "chunks" of 1-2 words for karaoke pacing.
function toKaraokeChunks(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; ) {
    const w = words[i];
    const next = words[i + 1];
    // Pair short words together for smoother rhythm
    if (next && (w.length + next.length) <= 8) {
      chunks.push(`${w} ${next}`);
      i += 2;
    } else {
      chunks.push(w);
      i += 1;
    }
  }
  return chunks.length ? chunks : [text];
}

// Build drawtext filters that show one chunk at a time centered near the bottom.
function karaokeFilters(text, sceneDur) {
  const chunks = toKaraokeChunks(text);
  const per = sceneDur / chunks.length;
  const fontfile = FONT_PATH.replace(/:/g, "\\:");
  return chunks.map((chunk, idx) => {
    const start = (idx * per).toFixed(3);
    const end = ((idx + 1) * per).toFixed(3);
    const txt = escDrawtext(chunk.toUpperCase());
    return `drawtext=fontfile='${fontfile}':text='${txt}':fontcolor=white:fontsize=88:borderw=6:bordercolor=black@0.9:box=1:boxcolor=black@0.55:boxborderw=22:x=(w-text_w)/2:y=h*0.66:enable='between(t,${start},${end})'`;
  }).join(",");
}

// Persistent bottom-left channel watermark.
function watermarkFilter() {
  const fontfile = FONT_PATH.replace(/:/g, "\\:");
  return `drawtext=fontfile='${fontfile}':text='${escDrawtext(CHANNEL_HANDLE)}':fontcolor=white@0.85:fontsize=34:borderw=3:bordercolor=black@0.85:x=32:y=h-th-46`;
}

// Progress bar that fills left→right across the whole video.
function progressBarFilter(totalDur) {
  return `drawbox=x=0:y=ih-14:w='iw*min(1,t/${totalDur.toFixed(3)})':h=14:color=yellow@0.95:t=fill`;
}

// Bold hook card overlay for first 1.4 seconds.
// NOTE inside drawbox `h`/`w` mean box size, so ALL references to input dimensions use `ih`/`iw`.
function hookFilter(hookText) {
  const fontfile = FONT_PATH.replace(/:/g, "\\:");
  const txt = escDrawtext((hookText || "").toUpperCase().slice(0, 60));
  return [
    `drawbox=x=0:y=ih*0.20:w=iw:h=ih*0.28:color=black@0.60:t=fill:enable='between(t,0,1.4)'`,
    `drawtext=fontfile='${fontfile}':text='${txt}':fontcolor=yellow:fontsize=110:borderw=8:bordercolor=black:x=(w-text_w)/2:y=h*0.28:enable='between(t,0,1.4)'`,
  ].join(",");
}

// End-card: "Subscribe to @CraftWebStudio" with a red subscribe button, last 2.5s.
function endCardFilter(totalDur) {
  const start = Math.max(0, totalDur - 2.5).toFixed(3);
  const end = totalDur.toFixed(3);
  const fontfile = FONT_PATH.replace(/:/g, "\\:");
  return [
    `drawbox=x=0:y=ih*0.30:w=iw:h=ih*0.40:color=black@0.72:t=fill:enable='between(t,${start},${end})'`,
    `drawtext=fontfile='${fontfile}':text='SUBSCRIBE TO':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.36:enable='between(t,${start},${end})'`,
    `drawtext=fontfile='${fontfile}':text='${escDrawtext(CHANNEL_HANDLE)}':fontcolor=yellow:fontsize=120:borderw=8:bordercolor=black:x=(w-text_w)/2:y=h*0.44:enable='between(t,${start},${end})'`,
    `drawbox=x=(iw-560)/2:y=ih*0.58:w=560:h=140:color=red@0.90:t=fill:enable='between(t,${start},${end})'`,
    `drawtext=fontfile='${fontfile}':text='SUBSCRIBE':fontcolor=white:fontsize=88:x=(w-text_w)/2:y=h*0.58+30:enable='between(t,${start},${end})'`,
    `drawtext=fontfile='${fontfile}':text='TAP THE BELL':fontcolor=white@0.9:fontsize=48:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.72:enable='between(t,${start},${end})'`,
  ].join(",");
}


async function processJob(job) {
  const workDir = join(tmpdir(), `sf-${job.videoId}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  // 1) Write assets and probe audio durations
  const scenes = [];
  for (let i = 0; i < 4; i++) {
    const img = join(workDir, `img${i}.jpg`);
    const aud = join(workDir, `aud${i}.mp3`);
    b64ToFile(job.images[i], img);
    b64ToFile(job.audios[i], aud);
    const dur = probeDuration(aud);
    scenes.push({ img, aud, dur, voText: job.plan.scenes?.[i]?.voiceover || "" });
  }

  // 2) Build per-scene silent 1080x1920 mp4 with Ken Burns + karaoke captions
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const { img, dur, voText } = scenes[i];
    const out = join(workDir, `clip${i}.mp4`);
    const frames = Math.round(dur * 30);
    const zoomIn = i % 2 === 0;
    const zoom = zoomIn
      ? `zoompan=z='min(zoom+0.0012,1.22)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`
      : `zoompan=z='if(lte(zoom,1.0),1.22,max(1.001,zoom-0.0012))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`;
    const scale = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`;
    const karaoke = karaokeFilters(voText, dur);
    let vf = `${scale},${zoom}`;
    if (karaoke) vf += `,${karaoke}`;
    if (i === 0 && job.plan.hook) vf += `,${hookFilter(job.plan.hook)}`;
    run("ffmpeg", ["-y", "-loop", "1", "-i", img, "-t", String(dur), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", "30", out]);
    clips.push({ out, dur });
  }

  // 3) Chain clips with xfade transitions (0.4s) — build a nested xfade filter graph
  const XFADE = 0.4;
  const videoConcat = join(workDir, "video.mp4");
  const totalVideoDur = clips.reduce((s, c) => s + c.dur, 0) - XFADE * (clips.length - 1);

  const xfadeArgs = ["-y"];
  for (const c of clips) xfadeArgs.push("-i", c.out);
  // Build xfade filter graph: [0][1]xfade=offset=d0-XFADE[v01]; [v01][2]xfade=offset=(d0-XFADE)+(d1-XFADE)[v02]; ...
  const transitions = ["fade", "slideleft", "fadegrays", "dissolve"];
  const filterParts = [];
  let prev = "[0:v]";
  let offset = clips[0].dur - XFADE;
  for (let i = 1; i < clips.length; i++) {
    const label = i === clips.length - 1 ? "[vout]" : `[v${i}]`;
    const t = transitions[(i - 1) % transitions.length];
    filterParts.push(`${prev}[${i}:v]xfade=transition=${t}:duration=${XFADE}:offset=${offset.toFixed(3)}${label}`);
    prev = label;
    if (i < clips.length - 1) offset += clips[i].dur - XFADE;
  }
  xfadeArgs.push("-filter_complex", filterParts.join(";"), "-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", videoConcat);
  run("ffmpeg", xfadeArgs);

  // 4) Voice track: concat with acrossfade of XFADE to match video overlap
  const voiceOut = join(workDir, "voice.mp3");
  const voiceArgs = ["-y"];
  for (const s of scenes) voiceArgs.push("-i", s.aud);
  const aParts = [];
  let aprev = "[0:a]";
  for (let i = 1; i < scenes.length; i++) {
    const label = i === scenes.length - 1 ? "[aout]" : `[a${i}]`;
    aParts.push(`${aprev}[${i}:a]acrossfade=d=${XFADE}:c1=tri:c2=tri${label}`);
    aprev = label;
  }
  voiceArgs.push("-filter_complex", aParts.join(";"), "-map", "[aout]", "-c:a", "libmp3lame", "-b:a", "160k", voiceOut);
  run("ffmpeg", voiceArgs);

  // 5) Music bed: synthesize a soft warm chord pad for totalVideoDur, then sidechain-duck it under the voice.
  //    C major triad (C4, E4, G4) with slight detune + slow tremolo + echo/reverb. Fully deterministic, zero license risk.
  const music = join(workDir, "music.mp3");
  const musicDur = Math.max(totalVideoDur, scenes.reduce((s,c)=>s+c.dur,0));
  const notes = [261.63, 329.63, 392.00, 523.25]; // C4, E4, G4, C5
  const detune = 0.6;
  const sineInputs = [];
  const sineFilters = [];
  notes.forEach((f, idx) => {
    sineInputs.push("-f", "lavfi", "-t", musicDur.toFixed(3), "-i", `sine=frequency=${f}:sample_rate=44100`);
    sineInputs.push("-f", "lavfi", "-t", musicDur.toFixed(3), "-i", `sine=frequency=${f + detune}:sample_rate=44100`);
    sineFilters.push(`[${idx * 2}:a][${idx * 2 + 1}:a]amix=inputs=2:normalize=0,volume=0.22[n${idx}]`);
  });
  const mixLine = notes.map((_, idx) => `[n${idx}]`).join("") + `amix=inputs=${notes.length}:normalize=0[mix]`;
  const musicFilter = [
    ...sineFilters,
    mixLine,
    `[mix]tremolo=f=0.25:d=0.35,lowpass=f=1600,aecho=0.7:0.7:120|240:0.35|0.20,volume=0.5[music]`,
  ].join(";");
  run("ffmpeg", ["-y", ...sineInputs, "-filter_complex", musicFilter, "-map", "[music]", "-c:a", "libmp3lame", "-b:a", "128k", music]);

  // 6) Mix voice + ducked music
  const audioFinal = join(workDir, "audio.mp3");
  const duckFilter = `[1:a]asplit=2[voice_out][voice_side];[0:a][voice_side]sidechaincompress=threshold=0.05:ratio=8:attack=15:release=250:makeup=1[music_ducked];[music_ducked][voice_out]amix=inputs=2:normalize=0:duration=longest[a]`;
  run("ffmpeg", ["-y", "-i", music, "-i", voiceOut, "-filter_complex", duckFilter, "-map", "[a]", "-c:a", "libmp3lame", "-b:a", "160k", audioFinal]);

  // 7) Final composite: video + audio + progress bar + watermark + end card
  const final = join(workDir, "final.mp4");
  const overlays = [
    progressBarFilter(totalVideoDur),
    watermarkFilter(),
    endCardFilter(totalVideoDur),
  ].join(",");
  run("ffmpeg", ["-y", "-i", videoConcat, "-i", audioFinal, "-vf", overlays, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", final]);

  // 8) Thumbnail: scene image 1 with big title + channel handle
  const thumb = join(workDir, "thumb.jpg");
  const title = (job.plan.title || "Watch this!").toUpperCase();
  const thumbText = escDrawtext(title.split(" ").slice(0, 5).join(" "));
  const fontfile = FONT_PATH.replace(/:/g, "\\:");
  run("ffmpeg", ["-y", "-i", scenes[0].img, "-vf",
    `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
    `drawbox=x=0:y=ih*0.55:w=iw:h=ih*0.45:color=black@0.65:t=fill,` +
    `drawtext=fontfile='${fontfile}':text='${thumbText}':fontcolor=yellow:fontsize=96:borderw=6:bordercolor=black:x=(w-text_w)/2:y=h*0.60,` +
    `drawtext=fontfile='${fontfile}':text='${escDrawtext(CHANNEL_HANDLE)}':fontcolor=white:fontsize=44:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-th-30`,
    "-q:v", "3", thumb]);

  const mp4Base64 = readFileSync(final).toString("base64");
  const thumbnailBase64 = readFileSync(thumb).toString("base64");

  // 9) SEO-optimized description + tags
  const hook = (job.plan.hook || job.plan.title || "").trim();
  const hashtags = (job.plan.hashtags || []).slice(0, 8).join(" ");
  const description = [
    hook,
    "",
    job.plan.description || "",
    "",
    `🔔 Subscribe to ${CHANNEL_HANDLE} for a new story every day!`,
    "💛 Which part surprised you? Comment below.",
    "",
    hashtags,
    "#shorts #shortsfeed #shortsfyp #storytime #animation #viralshorts",
  ].filter(Boolean).join("\n");

  const tags = Array.from(new Set([
    ...(job.plan.hashtags || []).map((h) => h.replace(/^#/, "")),
    "shorts", "shorts fyp", "viral shorts", "storytime shorts",
    "animation", "story", "cute", "funny", "kids", "storytime",
    "pixar style", "3d animation", "short story", "bedtime story",
    ...(job.rawTopic || "").toLowerCase().split(/\s+/).slice(0, 5),
  ])).filter((t) => t && t.length > 1).slice(0, 25);

  const uploadRes = await fetch(`${BASE}/api/public/autopilot/upload`, {
    method: "POST",
    headers: await autopilotHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      videoId: job.videoId,
      userId: job.userId,
      mp4Base64,
      thumbnailBase64,
      title: (job.plan.title || "New Short").slice(0, 100),
      description,
      tags,
      privacy: job.privacy,
      durationSeconds: totalVideoDur,
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

async function sendHeartbeat() {
  try {
    const res = await fetch(`${BASE}/api/public/autopilot/heartbeat?source=github`, {
      method: "POST",
      headers: await autopilotHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ mode: FORCE ? "force" : "scheduled", ranAt: new Date().toISOString() }),
    });
    if (res.ok) console.log("💓 Heartbeat sent to backend.");
    else console.warn(`Heartbeat failed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.warn("Heartbeat error:", err instanceof Error ? err.message : err);
  }
}

async function logDueSlotPreview() {
  try {
    const res = await fetch(`${BASE}/api/public/autopilot/tick?dryRun=1&limit=5`, {
      method: "POST",
      headers: await autopilotHeaders({ "Content-Type": "application/json" }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { console.log("Due-slot preview (raw):", text.slice(0, 400)); return; }
    console.log(`Due-slot preview: enabled=${json.enabledUsers ?? 0}, dueRightNow=${json.dueRightNow ?? 0}`);
    for (const p of json.preview || []) {
      console.log(`  · user=${p.userId.slice(0, 8)} tz=${p.timezone} slots=[${(p.slotHours || []).join(",")}] due=${p.isDue}`);
    }
  } catch (err) {
    console.warn("Due-slot preview failed:", err instanceof Error ? err.message : err);
  }
}

async function main() {
  console.log(`Fetching autopilot jobs from ${BASE}...`);
  await sendHeartbeat();
  await logDueSlotPreview();
  if (FORCE) {
    console.log("Manual test mode: uploading the latest ready Test Flow video. No new generation will run.");
    const runRes = await fetch(`${BASE}/api/public/autopilot/run-workflow`, {
      method: "POST",
      headers: await autopilotHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ privacy: "public" }),
    });
    const runText = await runRes.text();
    let runJson;
    try { runJson = JSON.parse(runText); }
    catch { throw new Error(`Run workflow returned non-JSON (${runRes.status}): ${runText.slice(0, 1000)}`); }
    if (!runRes.ok || runJson?.ok === false) {
      console.error(`Run workflow failed HTTP ${runRes.status}`);
      console.error(`Response body: ${runText.slice(0, 2000)}`);
      if (runRes.status === 401) console.error("Fix: publish the latest app changes and make sure this workflow has id-token: write permission.");
      throw new Error(runJson?.error || `Run workflow failed ${runRes.status}`);
    }
    console.log(`✅ Uploaded to YouTube! Video ID: ${runJson.youtubeVideoId}`);
    console.log(`View on YouTube: ${runJson.youtubeUrl}`);
    return;
  }

  console.log("Scheduled mode: checking due upload slots.");
  try {
    const retryRes = await fetch(`${BASE}/api/public/autopilot/run-workflow`, {
      method: "POST",
      headers: await autopilotHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ privacy: "public", onlyAutopilot: true }),
    });
    const retryText = await retryRes.text();
    let retryJson = null;
    try { retryJson = JSON.parse(retryText); } catch {}
    if (retryRes.ok && retryJson?.ok) {
      console.log(`Retried pending autopilot upload: ${retryJson.youtubeUrl}`);
    } else {
      console.log(`No pending rendered autopilot upload to retry: ${retryJson?.error || retryText.slice(0, 300)}`);
    }
  } catch (retryErr) {
    console.log("Pending upload retry check failed; continuing to due slot generation:", retryErr instanceof Error ? retryErr.message : retryErr);
  }
  const endpoint = `${BASE}/api/public/autopilot/tick?limit=5`;
  const tickRes = await fetch(endpoint, {
    method: "POST",
    headers: await autopilotHeaders(),
  });
  const tickText = await tickRes.text();
  if (!tickRes.ok) {
    console.error(`Tick failed HTTP ${tickRes.status}`);
    console.error(`Response body: ${tickText.slice(0, 2000)}`);
    if (tickRes.status === 401) {
      console.error("Fix: publish the latest app changes and make sure this workflow has id-token: write permission.");
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
