// Client-side sequential MP4 stitcher with animated SUBSCRIBE overlay.
// Runs entirely in the browser using canvas + MediaRecorder — no server, no ffmpeg.

export type StitchScene = { url: string; order: number };
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
  for (const c of cands) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  return "video/webm";
}

export function extForMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  return "webm";
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.playsInline = true;
    v.muted = true;
    v.preload = "auto";
    v.src = url;
    v.onloadedmetadata = () => resolve(v);
    v.onerror = () => reject(new Error(`Failed to load scene clip: ${url}`));
  });
}

function drawCoverFit(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
) {
  const vw = video.videoWidth || w;
  const vh = video.videoHeight || h;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  ctx.drawImage(video, dx, dy, dw, dh);
}

function drawCta(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ctaTop: string,
  ctaBottom: string,
  progress: number, // 0..1 during overlay window
) {
  const easeIn = Math.min(1, progress * 3); // pop-in over first third
  const bounce = 1 + Math.sin(progress * Math.PI * 6) * 0.03 * (1 - progress);

  // TOP text ("Comment for part 2")
  const topFont = Math.round(w * 0.05);
  ctx.font = `700 ${topFont}px "Titan One","Fredoka One","Impact","Arial Black",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const topY = h * 0.08;
  ctx.globalAlpha = easeIn;
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillText(ctaTop, w / 2 + 3, topY + 3);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(ctaTop, w / 2, topY);

  // BOTTOM subscribe ribbon
  const boxH = Math.round(w * 0.14);
  const boxW = Math.round(w * 0.72) * bounce;
  const boxX = (w - boxW) / 2;
  const boxY = h - h * 0.15 - boxH / 2;
  ctx.globalAlpha = easeIn;
  // yellow ribbon
  const grad = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
  grad.addColorStop(0, "#ffe259");
  grad.addColorStop(1, "#ffa751");
  ctx.fillStyle = grad;
  const r = boxH * 0.25;
  roundRect(ctx, boxX, boxY, boxW, boxH, r);
  ctx.fill();
  // black outline
  ctx.lineWidth = Math.max(4, w * 0.006);
  ctx.strokeStyle = "#111";
  ctx.stroke();
  // SUBSCRIBE text
  const btnFont = Math.round(boxH * 0.55);
  ctx.font = `900 ${btnFont}px "Titan One","Fredoka One","Impact","Arial Black",sans-serif`;
  ctx.fillStyle = "#111";
  ctx.textBaseline = "middle";
  ctx.fillText(ctaBottom, w / 2, boxY + boxH / 2 + 2);
  ctx.globalAlpha = 1;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function playSceneToCanvas(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  isLastScene: boolean,
  ctaTop: string,
  ctaBottom: string,
  onFrame?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let raf = 0;
    let stopped = false;
    const dur = Math.min(video.duration || 5, 12);
    const ctaWindow = Math.min(3, Math.max(1.5, dur * 0.6)); // last N seconds get CTA
    const ctaStart = dur - ctaWindow;

    const tick = () => {
      if (stopped) return;
      drawCoverFit(ctx, video, w, h);
      if (isLastScene && video.currentTime >= ctaStart) {
        const p = Math.min(1, (video.currentTime - ctaStart) / ctaWindow);
        drawCta(ctx, w, h, ctaTop, ctaBottom, p);
      }
      onFrame?.();
      if (video.ended || video.currentTime >= dur - 0.03) {
        stopped = true;
        cancelAnimationFrame(raf);
        video.pause();
        resolve();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    video.onended = () => {
      if (!stopped) {
        stopped = true;
        cancelAnimationFrame(raf);
        resolve();
      }
    };
    video.onerror = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      reject(new Error("Video playback error"));
    };
    video.currentTime = 0;
    video
      .play()
      .then(() => {
        raf = requestAnimationFrame(tick);
      })
      .catch(reject);
  });
}

export async function stitchClips(opts: StitchOptions): Promise<{ blob: Blob; durationSeconds: number }> {
  const w = opts.width ?? 720; // ~9:16 keeps recording sane; scale up to 1080 costs more CPU
  const h = opts.height ?? 1280;
  const fps = opts.fps ?? 30;

  opts.onProgress?.(60, "Preloading scene clips…");
  const scenes = [...opts.scenes].sort((a, b) => a.order - b.order);
  const videos: HTMLVideoElement[] = [];
  for (const s of scenes) videos.push(await loadVideo(s.url));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unsupported");

  // Prime with a black frame so recorder gets a valid frame at t=0
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const stream = canvas.captureStream(fps);
  const mime = pickMime();
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => e.data && e.data.size > 0 && chunks.push(e.data);
  const done = new Promise<void>((res) => (rec.onstop = () => res()));
  rec.start(500);

  const totalDur = videos.reduce((s, v) => s + Math.min(v.duration || 5, 12), 0);
  let elapsed = 0;

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const isLast = i === videos.length - 1;
    opts.onProgress?.(60 + Math.round((elapsed / totalDur) * 35), `Rendering scene ${i + 1} / ${videos.length}…`);
    await playSceneToCanvas(v, ctx, w, h, isLast, opts.ctaTop, opts.ctaBottom, () => {});
    elapsed += Math.min(v.duration || 5, 12);
  }

  rec.stop();
  await done;
  const blob = new Blob(chunks, { type: mime });
  return { blob, durationSeconds: totalDur };
}
