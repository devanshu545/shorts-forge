// Client-side animated video renderer.
// Uses Canvas + MediaRecorder to produce a silent, caption-less WebM entirely in the browser.
// Zero paid API calls — characters are drawn from emoji + primitive shapes.

import type { AnimationPlan } from "./plan.functions";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

type Character = AnimationPlan["scenes"][number]["characters"][number];

// ─────────────── backgrounds ───────────────
const BG_GRADIENTS: Record<string, [string, string, string]> = {
  park: ["#7dd3fc", "#bef264", "#65a30d"],
  city: ["#1e293b", "#475569", "#94a3b8"],
  kitchen: ["#fde68a", "#fb923c", "#c2410c"],
  sky: ["#93c5fd", "#c4b5fd", "#f0abfc"],
  office: ["#e2e8f0", "#cbd5e1", "#94a3b8"],
  gym: ["#0f172a", "#dc2626", "#450a0a"],
  beach: ["#38bdf8", "#fde68a", "#f59e0b"],
  space: ["#020617", "#3730a3", "#7c3aed"],
  classroom: ["#fef3c7", "#a3e635", "#65a30d"],
  stage: ["#4c1d95", "#db2777", "#f59e0b"],
  cafe: ["#78350f", "#d97706", "#fef3c7"],
  street: ["#334155", "#64748b", "#f1f5f9"],
};

const BG_DECOR: Record<string, string[]> = {
  park: ["🌳", "🌲", "🌸", "🌤️", "🦋"],
  city: ["🏙️", "🏢", "🚕", "🚦"],
  kitchen: ["🍳", "🥘", "🍕", "🧀"],
  sky: ["☁️", "☁️", "🌈", "🌤️"],
  office: ["💼", "🖥️", "📊", "☕"],
  gym: ["🏋️", "🥊", "💪", "🔥"],
  beach: ["🌊", "🏖️", "🐚", "🌴"],
  space: ["⭐", "✨", "🪐", "🚀", "🌙"],
  classroom: ["📚", "🍎", "✏️", "🎒"],
  stage: ["🎭", "🎪", "✨", "🎤"],
  cafe: ["☕", "🥐", "🍰", "📖"],
  street: ["🚗", "🚦", "🏬", "🚶"],
};

const PROP_EMOJI: Record<string, string> = {
  none: "",
  ball: "⚽",
  heart: "❤️",
  money: "💰",
  star: "⭐",
  lightning: "⚡",
  question: "❓",
  coffee: "☕",
  phone: "📱",
  gift: "🎁",
  trophy: "🏆",
  bomb: "💣",
  fire: "🔥",
};

// Each action maps to (emoji sprite, motion fn).
type Motion = (t: number, dur: number) => { dx: number; dy: number; rot: number; scaleBoost: number };

const linear = (t: number, dur: number) => Math.min(1, t / dur);
const swing = (t: number) => Math.sin(t * Math.PI * 2);

const ACTION_EMOJI: Record<string, string> = {
  idle: "🧍",
  walk: "🚶",
  run: "🏃",
  jump: "🤸",
  wave: "🙋",
  spin: "💫",
  fall: "🤦",
  dance: "💃",
  chase: "🏃",
  punch: "🥊",
  celebrate: "🙌",
  think: "🤔",
  cry: "😭",
  laugh: "🤣",
  shock: "😱",
  love: "😍",
};

const ACTION_MOTION: Record<string, Motion> = {
  idle: (t) => ({ dx: 0, dy: Math.sin(t * 3) * 6, rot: 0, scaleBoost: 0 }),
  walk: (t, d) => ({ dx: linear(t, d) * 400 - 200, dy: Math.abs(Math.sin(t * 8)) * -10, rot: 0, scaleBoost: 0 }),
  run: (t, d) => ({ dx: linear(t, d) * 600 - 300, dy: Math.abs(Math.sin(t * 12)) * -18, rot: 0, scaleBoost: 0 }),
  jump: (t, d) => ({ dx: 0, dy: -Math.sin(linear(t, d) * Math.PI) * 260, rot: 0, scaleBoost: 0 }),
  wave: (t) => ({ dx: 0, dy: Math.sin(t * 2) * 4, rot: Math.sin(t * 5) * 0.1, scaleBoost: 0 }),
  spin: (t) => ({ dx: 0, dy: 0, rot: t * Math.PI * 2, scaleBoost: 0 }),
  fall: (t, d) => ({ dx: 0, dy: linear(t, d) * 180, rot: linear(t, d) * Math.PI * 0.7, scaleBoost: 0 }),
  dance: (t) => ({ dx: Math.sin(t * 6) * 40, dy: Math.abs(Math.sin(t * 10)) * -20, rot: Math.sin(t * 4) * 0.15, scaleBoost: Math.sin(t * 8) * 0.05 }),
  chase: (t, d) => ({ dx: linear(t, d) * 800 - 400, dy: Math.abs(Math.sin(t * 14)) * -14, rot: 0, scaleBoost: 0 }),
  punch: (t) => ({ dx: Math.sin(t * 6) * 60, dy: 0, rot: 0, scaleBoost: Math.abs(Math.sin(t * 6)) * 0.2 }),
  celebrate: (t) => ({ dx: 0, dy: -Math.abs(Math.sin(t * 4)) * 40, rot: swing(t / 2) * 0.1, scaleBoost: Math.sin(t * 4) * 0.08 }),
  think: (t) => ({ dx: Math.sin(t * 1.2) * 8, dy: 0, rot: Math.sin(t * 1.2) * 0.05, scaleBoost: 0 }),
  cry: (t) => ({ dx: 0, dy: Math.sin(t * 6) * 6, rot: Math.sin(t * 3) * 0.05, scaleBoost: 0 }),
  laugh: (t) => ({ dx: 0, dy: Math.abs(Math.sin(t * 8)) * -14, rot: 0, scaleBoost: Math.abs(Math.sin(t * 8)) * 0.1 }),
  shock: (t) => ({ dx: 0, dy: t < 0.3 ? -30 : 0, rot: 0, scaleBoost: t < 0.3 ? 0.15 : 0 }),
  love: (t) => ({ dx: 0, dy: Math.sin(t * 3) * 8, rot: Math.sin(t * 2) * 0.05, scaleBoost: Math.sin(t * 3) * 0.05 }),
};

// ─────────────── drawing ───────────────
function drawBackground(ctx: CanvasRenderingContext2D, bg: string, t: number) {
  const [a, b, c] = BG_GRADIENTS[bg] || BG_GRADIENTS.park;
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, a);
  grad.addColorStop(0.55, b);
  grad.addColorStop(1, c);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // ground
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.fillRect(0, HEIGHT * 0.82, WIDTH, HEIGHT * 0.18);

  // decor emoji (parallax drift)
  const decor = BG_DECOR[bg] || [];
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  decor.forEach((emoji, i) => {
    const baseX = ((i + 0.5) / decor.length) * WIDTH;
    const drift = Math.sin(t * 0.5 + i) * 30;
    const y = 220 + (i % 2) * 140;
    ctx.font = "180px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
    ctx.globalAlpha = 0.85;
    ctx.fillText(emoji, baseX + drift, y);
  });
  ctx.globalAlpha = 1;
}

function drawCharacter(ctx: CanvasRenderingContext2D, c: Character, t: number, dur: number) {
  const motion = (ACTION_MOTION[c.action] || ACTION_MOTION.idle)(t, dur);
  const baseX = c.startX * WIDTH;
  const baseY = c.startY * HEIGHT;
  const x = baseX + motion.dx * (c.direction === "left" ? -1 : 1);
  const y = baseY + motion.dy;
  const scale = (c.scale || 1) + motion.scaleBoost;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(motion.rot);
  if (c.direction === "left") ctx.scale(-1, 1);
  ctx.scale(scale, scale);

  // colored circle backdrop (character "aura")
  ctx.beginPath();
  ctx.arc(0, 0, 200, 0, Math.PI * 2);
  ctx.fillStyle = c.color + "55";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 150, 0, Math.PI * 2);
  ctx.fillStyle = c.color + "cc";
  ctx.fill();

  // emoji sprite for the action
  const emoji = ACTION_EMOJI[c.action] || ACTION_EMOJI.idle;
  ctx.font = "300px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (c.direction === "left") ctx.scale(-1, 1); // un-mirror emoji so it stays readable
  ctx.fillText(emoji, 0, 20);

  ctx.restore();
}

function drawProp(ctx: CanvasRenderingContext2D, prop: string, t: number) {
  const emoji = PROP_EMOJI[prop];
  if (!emoji) return;
  const orbit = 200;
  const cx = WIDTH / 2 + Math.cos(t * 2) * orbit;
  const cy = HEIGHT * 0.5 + Math.sin(t * 2) * orbit * 0.5;
  ctx.font = "220px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 3);
  ctx.fillText(emoji, 0, 0);
  ctx.restore();
}

function drawCaption(ctx: CanvasRenderingContext2D, emoji: string, t: number, dur: number) {
  if (!emoji) return;
  const enter = Math.min(1, t * 3);
  const exit = Math.max(0, 1 - Math.max(0, t - (dur - 0.4)) * 2.5);
  const alpha = Math.min(enter, exit);
  const y = HEIGHT * 0.18 - (1 - enter) * 60;
  ctx.globalAlpha = alpha;
  ctx.font = "360px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, WIDTH / 2, y);
  ctx.globalAlpha = 1;
}

// ─────────────── render loop ───────────────
export type ProgressCallback = (progress: number, stage: string) => void;

export async function renderAnimatedShort(plan: AnimationPlan, onProgress: ProgressCallback): Promise<Blob> {
  if (typeof window === "undefined") throw new Error("renderAnimatedShort must run in the browser");

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const stream = canvas.captureStream(FPS);
  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const totalDuration = plan.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  const totalFrames = Math.round(totalDuration * FPS);

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (e) => reject((e as any).error || new Error("MediaRecorder error"));
  });

  recorder.start(200);
  onProgress(5, "Warming up the animator…");

  // Prime the fonts + first frame so the browser has emoji glyphs decoded.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  await new Promise((r) => setTimeout(r, 100));

  let sceneStart = 0;
  for (let s = 0; s < plan.scenes.length; s += 1) {
    const scene = plan.scenes[s];
    const sceneFrames = Math.round(scene.durationSeconds * FPS);
    for (let f = 0; f < sceneFrames; f += 1) {
      const localT = f / FPS;
      const globalFrame = Math.round(sceneStart * FPS) + f;
      drawBackground(ctx, scene.background, localT);
      drawProp(ctx, scene.prop, localT);
      scene.characters.forEach((c) => drawCharacter(ctx, c, localT, scene.durationSeconds));
      drawCaption(ctx, scene.captionEmoji, localT, scene.durationSeconds);
      // yield to the browser so the captured stream picks up this frame
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (globalFrame % 15 === 0) {
        const pct = 5 + Math.round((globalFrame / totalFrames) * 85);
        onProgress(pct, `Rendering scene ${s + 1}/${plan.scenes.length} — frame ${globalFrame}/${totalFrames}`);
      }
    }
    sceneStart += scene.durationSeconds;
  }

  onProgress(92, "Finalizing video…");
  recorder.stop();
  const blob = await done;
  onProgress(96, "Encoding done");
  return blob;
}

function pickMime(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

export function extForMime(mime: string) {
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}
