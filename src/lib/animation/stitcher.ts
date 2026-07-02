// Client-side Ken-Burns animator + stitcher — no server, no ffmpeg, no paid API.
// Takes still keyframes and animates them (zoom/pan) with crossfade transitions,
// then records the canvas via MediaRecorder into a WebM.

export type StitchScene = { url: string; order: number; durationSeconds?: number };
export type StitchOptions = {
  scenes: StitchScene[];
  ctaTop: string;
  ctaBottom: string;
  width?: number;
  height?: number;
  fps?: number;
  onProgress?: (pct: number, stage: string) => void;
};

export function pickMime(): string {
  const cands = [
    "video/webm;codecs=vp9,opus",
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

function drawKenBurns(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  t: number, // 0..1 scene progress
  motion: { zoomFrom: number; zoomTo: number; panX: number; panY: number },
) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const coverScale = Math.max(w / iw, h / ih);
  const zoom = motion.zoomFrom + (motion.zoomTo - motion.zoomFrom) * t;
  const scale = coverScale * zoom;
  const dw = iw * scale;
  const dh = ih * scale;
  // pan across the extra space
  const extraX = dw - w;
  const extraY = dh - h;
  const px = -extraX / 2 + motion.panX * extraX * (t - 0.5);
  const py = -extraY / 2 + motion.panY * extraY * (t - 0.5);
  ctx.drawImage(img, px, py, dw, dh);
}

const MOTIONS = [
  { zoomFrom: 1.0, zoomTo: 1.18, panX: 0.4, panY: 0.0 }, // slow zoom-in, pan right
  { zoomFrom: 1.15, zoomTo: 1.0, panX: -0.3, panY: 0.2 }, // pull back, pan left-down
  { zoomFrom: 1.05, zoomTo: 1.2, panX: 0.0, panY: -0.4 }, // dolly in, pan up
  { zoomFrom: 1.2, zoomTo: 1.05, panX: 0.3, panY: 0.3 }, // pull back, pan right-down
] as const;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCta(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ctaTop: string,
  ctaBottom: string,
  progress: number,
) {
  const easeIn = Math.min(1, progress * 3);
  const bounce = 1 + Math.sin(progress * Math.PI * 6) * 0.03 * (1 - progress);

  // Top text
  const topFont = Math.round(w * 0.055);
  ctx.font = `900 ${topFont}px "Titan One","Fredoka One","Impact","Arial Black",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const topY = h * 0.09;
  ctx.globalAlpha = easeIn;
  ctx.fillStyle = "rgba(0,0,0,0.8)";
  ctx.fillText(ctaTop, w / 2 + 3, topY + 3);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(ctaTop, w / 2, topY);

  // Bottom subscribe ribbon
  const boxH = Math.round(w * 0.14);
  const boxW = Math.round(w * 0.72) * bounce;
  const boxX = (w - boxW) / 2;
  const boxY = h - h * 0.14 - boxH / 2;
  const grad = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
  grad.addColorStop(0, "#ffe259");
  grad.addColorStop(1, "#ffa751");
  ctx.fillStyle = grad;
  const r = boxH * 0.25;
  roundRect(ctx, boxX, boxY, boxW, boxH, r);
  ctx.fill();
  ctx.lineWidth = Math.max(4, w * 0.006);
  ctx.strokeStyle = "#111";
  ctx.stroke();

  const btnFont = Math.round(boxH * 0.55);
  ctx.font = `900 ${btnFont}px "Titan One","Fredoka One","Impact","Arial Black",sans-serif`;
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
  for (const s of scenes) images.push(await loadImage(s.url));

  const sceneDur = 5; // seconds per scene
  const fadeDur = 0.6; // crossfade seconds
  const totalDur = scenes.length * sceneDur;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unsupported");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const stream = canvas.captureStream(fps);
  const mime = pickMime();
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => e.data && e.data.size > 0 && chunks.push(e.data);
  const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
  rec.start(500);

  const startedAt = performance.now();
  const totalMs = totalDur * 1000;
  const isLastCtaStart = totalDur - Math.min(3, sceneDur * 0.6);

  await new Promise<void>((resolve) => {
    const tick = () => {
      const nowMs = performance.now() - startedAt;
      if (nowMs >= totalMs) {
        resolve();
        return;
      }
      const nowSec = nowMs / 1000;
      const sceneIdx = Math.min(scenes.length - 1, Math.floor(nowSec / sceneDur));
      const inSceneT = (nowSec - sceneIdx * sceneDur) / sceneDur;

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);

      drawKenBurns(ctx, images[sceneIdx], w, h, inSceneT, MOTIONS[sceneIdx % MOTIONS.length]);

      // Crossfade into next scene
      const timeIntoScene = nowSec - sceneIdx * sceneDur;
      const timeLeft = sceneDur - timeIntoScene;
      if (timeLeft < fadeDur && sceneIdx < scenes.length - 1) {
        const alpha = 1 - timeLeft / fadeDur;
        ctx.globalAlpha = alpha;
        drawKenBurns(
          ctx,
          images[sceneIdx + 1],
          w,
          h,
          0,
          MOTIONS[(sceneIdx + 1) % MOTIONS.length],
        );
        ctx.globalAlpha = 1;
      }

      // CTA overlay in last chunk
      if (nowSec >= isLastCtaStart) {
        const p = Math.min(1, (nowSec - isLastCtaStart) / (totalDur - isLastCtaStart));
        drawCta(ctx, w, h, opts.ctaTop, opts.ctaBottom, p);
      }

      opts.onProgress?.(
        60 + Math.round((nowMs / totalMs) * 35),
        `Rendering ${Math.min(scenes.length, sceneIdx + 1)} / ${scenes.length}…`,
      );

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Small tail so recorder captures final frame
  await new Promise((r) => setTimeout(r, 250));
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mime });
  return { blob, durationSeconds: totalDur };
}
