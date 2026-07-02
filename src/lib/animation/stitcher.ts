// Narrated Ken-Burns stitcher — free, all client-side.
// Takes one still keyframe + one narration MP3 per scene, animates each image with
// Ken Burns motion for the length of that scene's audio, mixes narration + video
// into a single WebM via canvas.captureStream() + WebAudio destination stream.

export type StitchScene = {
  imageUrl: string;
  audioUrl?: string;
  order: number;
};
export type StitchOptions = {
  scenes: StitchScene[];
  ctaTop: string;
  ctaBottom: string;
  width?: number;
  height?: number;
  fps?: number;
  onProgress?: (pct: number, stage: string) => void;
};

const MIN_SCENE = 3;
const MAX_SCENE = 8;
const END_CARD_SECONDS = 2.2;
const FADE_SECONDS = 0.5;

export function pickMime(): string {
  const cands = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const c of cands)
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  return "video/webm";
}
export function extForMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  return "webm";
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load keyframe: ${url}`));
    img.src = url;
  });
}

async function fetchAudioBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Audio fetch failed (${res.status})`);
  const arr = await res.arrayBuffer();
  return await ctx.decodeAudioData(arr);
}

function drawKenBurns(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  t: number,
  motion: { zoomFrom: number; zoomTo: number; panX: number; panY: number },
) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const coverScale = Math.max(w / iw, h / ih);
  const zoom = motion.zoomFrom + (motion.zoomTo - motion.zoomFrom) * t;
  const scale = coverScale * zoom;
  const dw = iw * scale;
  const dh = ih * scale;
  const extraX = dw - w;
  const extraY = dh - h;
  const px = -extraX / 2 + motion.panX * extraX * (t - 0.5);
  const py = -extraY / 2 + motion.panY * extraY * (t - 0.5);
  ctx.drawImage(img, px, py, dw, dh);
}

const MOTIONS = [
  { zoomFrom: 1.0, zoomTo: 1.18, panX: 0.4, panY: 0.0 },
  { zoomFrom: 1.15, zoomTo: 1.0, panX: -0.3, panY: 0.2 },
  { zoomFrom: 1.05, zoomTo: 1.2, panX: 0.0, panY: -0.4 },
  { zoomFrom: 1.2, zoomTo: 1.05, panX: 0.3, panY: 0.3 },
] as const;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Small persistent watermark bottom-right
function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, ctaBottom: string) {
  const boxH = Math.round(w * 0.06);
  const padX = Math.round(w * 0.045);
  ctx.font = `900 ${Math.round(boxH * 0.55)}px "Fredoka One","Impact","Arial Black",sans-serif`;
  const textW = ctx.measureText(ctaBottom).width;
  const boxW = textW + padX * 2;
  const boxX = w - boxW - Math.round(w * 0.03);
  const boxY = h - boxH - Math.round(w * 0.05);

  ctx.globalAlpha = 0.85;
  const grad = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
  grad.addColorStop(0, "#ffe259");
  grad.addColorStop(1, "#ffa751");
  ctx.fillStyle = grad;
  roundRect(ctx, boxX, boxY, boxW, boxH, boxH * 0.35);
  ctx.fill();
  ctx.lineWidth = Math.max(2, w * 0.003);
  ctx.strokeStyle = "#111";
  ctx.stroke();

  ctx.fillStyle = "#111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ctaBottom, boxX + boxW / 2, boxY + boxH / 2 + 1);
  ctx.globalAlpha = 1;
}

// Big end card at the very end
function drawEndCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ctaTop: string,
  ctaBottom: string,
  progress: number, // 0..1
) {
  // dark scrim
  ctx.globalAlpha = Math.min(0.55, progress * 0.9);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;

  const easeIn = Math.min(1, progress * 2.5);
  const bounce = 1 + Math.sin(progress * Math.PI * 5) * 0.04 * (1 - progress);

  // top text
  const topFont = Math.round(w * 0.06);
  ctx.font = `900 ${topFont}px "Fredoka One","Impact","Arial Black",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const topY = h * 0.35;
  ctx.globalAlpha = easeIn;
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.fillText(ctaTop, w / 2 + 3, topY + 3);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(ctaTop, w / 2, topY);

  // big subscribe ribbon
  const boxH = Math.round(w * 0.18);
  const boxW = Math.round(w * 0.78) * bounce;
  const boxX = (w - boxW) / 2;
  const boxY = h * 0.55;
  const grad = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
  grad.addColorStop(0, "#ffe259");
  grad.addColorStop(1, "#ffa751");
  ctx.fillStyle = grad;
  roundRect(ctx, boxX, boxY, boxW, boxH, boxH * 0.28);
  ctx.fill();
  ctx.lineWidth = Math.max(4, w * 0.007);
  ctx.strokeStyle = "#111";
  ctx.stroke();

  const btnFont = Math.round(boxH * 0.55);
  ctx.font = `900 ${btnFont}px "Fredoka One","Impact","Arial Black",sans-serif`;
  ctx.fillStyle = "#111";
  ctx.textBaseline = "middle";
  ctx.fillText(ctaBottom, w / 2, boxY + boxH / 2 + 2);
  ctx.globalAlpha = 1;
}

export async function stitchClips(
  opts: StitchOptions,
): Promise<{ blob: Blob; durationSeconds: number }> {
  const w = opts.width ?? 720;
  const h = opts.height ?? 1280;
  const fps = opts.fps ?? 30;

  opts.onProgress?.(60, "Preloading keyframes…");
  const scenes = [...opts.scenes].sort((a, b) => a.order - b.order);
  const images: HTMLImageElement[] = [];
  for (const s of scenes) images.push(await loadImage(s.imageUrl));

  // Audio: decode all narrations, derive per-scene duration
  type Ctor = { new (options?: AudioContextOptions): AudioContext };
  const AC: Ctor =
    (window.AudioContext as unknown as Ctor) ||
    ((window as unknown as { webkitAudioContext: Ctor }).webkitAudioContext);
  const audioCtx = new AC();
  if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});

  opts.onProgress?.(65, "Loading narration…");
  const buffers: (AudioBuffer | null)[] = [];
  for (const s of scenes) {
    if (!s.audioUrl) {
      buffers.push(null);
      continue;
    }
    try {
      buffers.push(await fetchAudioBuffer(audioCtx, s.audioUrl));
    } catch {
      buffers.push(null);
    }
  }

  const sceneDurations = buffers.map((b) => {
    if (!b) return 5;
    return Math.max(MIN_SCENE, Math.min(MAX_SCENE, b.duration + 0.3));
  });
  const bodyDur = sceneDurations.reduce((a, b) => a + b, 0);
  const totalDur = bodyDur + END_CARD_SECONDS;

  // Scene start offsets
  const starts: number[] = [];
  let acc = 0;
  for (const d of sceneDurations) {
    starts.push(acc);
    acc += d;
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unsupported");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  // Video stream from canvas
  const videoStream = canvas.captureStream(fps);

  // Audio: mix each scene's buffer into a destination stream at its scheduled time
  const audioDest = audioCtx.createMediaStreamDestination();
  const combined = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...audioDest.stream.getAudioTracks(),
  ]);

  const mime = pickMime();
  const rec = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => e.data && e.data.size > 0 && chunks.push(e.data);
  const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
  rec.start(500);

  // Schedule all narration on the AudioContext timeline, offset from now
  const audioStartAt = audioCtx.currentTime + 0.15;
  for (let i = 0; i < scenes.length; i++) {
    const buf = buffers[i];
    if (!buf) continue;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioDest);
    src.start(audioStartAt + starts[i]);
  }

  const renderStart = performance.now();
  const totalMs = totalDur * 1000;

  await new Promise<void>((resolve) => {
    const tick = () => {
      const nowMs = performance.now() - renderStart;
      if (nowMs >= totalMs) {
        resolve();
        return;
      }
      const nowSec = nowMs / 1000;

      // Determine current scene
      let sceneIdx = scenes.length - 1;
      for (let i = 0; i < starts.length; i++) {
        if (nowSec < starts[i] + sceneDurations[i]) {
          sceneIdx = i;
          break;
        }
      }
      const localT = Math.min(1, (nowSec - starts[sceneIdx]) / sceneDurations[sceneIdx]);

      // Base image
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      drawKenBurns(ctx, images[sceneIdx], w, h, localT, MOTIONS[sceneIdx % MOTIONS.length]);

      // Crossfade into next scene
      const timeLeftInScene = sceneDurations[sceneIdx] - (nowSec - starts[sceneIdx]);
      if (timeLeftInScene < FADE_SECONDS && sceneIdx < scenes.length - 1) {
        const alpha = 1 - timeLeftInScene / FADE_SECONDS;
        ctx.globalAlpha = alpha;
        drawKenBurns(ctx, images[sceneIdx + 1], w, h, 0, MOTIONS[(sceneIdx + 1) % MOTIONS.length]);
        ctx.globalAlpha = 1;
      }

      // Persistent SUBSCRIBE watermark on every frame
      drawWatermark(ctx, w, h, opts.ctaBottom);

      // End card in the last END_CARD_SECONDS
      if (nowSec >= bodyDur) {
        const p = Math.min(1, (nowSec - bodyDur) / END_CARD_SECONDS);
        drawEndCard(ctx, w, h, opts.ctaTop, opts.ctaBottom, p);
      }

      opts.onProgress?.(
        60 + Math.round((nowMs / totalMs) * 35),
        `Rendering scene ${Math.min(scenes.length, sceneIdx + 1)} / ${scenes.length}…`,
      );

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await new Promise((r) => setTimeout(r, 300));
  rec.stop();
  await stopped;
  try {
    await audioCtx.close();
  } catch {
    /* ignore */
  }
  const blob = new Blob(chunks, { type: mime });
  return { blob, durationSeconds: totalDur };
}
