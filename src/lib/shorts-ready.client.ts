// Post-generation Shorts-ready conversion — runs in the user's browser
// via ffmpeg.wasm right before upload. Does NOT touch the generation pipeline,
// storage, workers, DB, or any existing server code paths. The original
// generated MP4 in Supabase Storage is never modified.
//
// Strategy per clip:
//   1. Fetch generated MP4 bytes.
//   2. Inline mini-MP4 parser probes ftyp/moov/mvhd/tkhd/stsd. If the file is
//      already true-vertical 1080x1920, H.264 avc1, AAC, moov-before-mdat,
//      no rotation matrix, and <=60s -> return `null` (reuse original bytes).
//   3. Otherwise run ffmpeg.wasm with a cover-style filter (blurred bg +
//      centered subject, no black bars, 1080x1920 physical pixels, H.264
//      high@4.1, AAC 128kbps, +faststart) and return the new Blob.
//
// If conversion or post-conversion validation fails, the caller must abort
// the upload -- we never send a bad file to YouTube.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

const CORE_JS_URL = "/ffmpeg-core/ffmpeg-core.js";
const WASM_MANIFEST_URL = "/ffmpeg-core/ffmpeg-core.wasm.asset.json";

let sharedFfmpeg: FFmpeg | null = null;

async function getLocalWasmUrl(): Promise<string> {
  const res = await fetch(WASM_MANIFEST_URL, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Cannot load ffmpeg wasm manifest (${res.status})`);
  const manifest = (await res.json()) as { url?: string };
  if (!manifest.url) throw new Error("ffmpeg wasm manifest missing asset URL");
  return new URL(manifest.url, window.location.origin).href;
}

async function getFfmpeg(onLog?: (m: string) => void): Promise<FFmpeg> {
  if (sharedFfmpeg) return sharedFfmpeg;
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => onLog?.(message));
  const [wasmURL, coreURL] = await Promise.all([
    getLocalWasmUrl(),
    Promise.resolve(new URL(CORE_JS_URL, window.location.origin).href),
  ]);
  await ff.load({ coreURL, wasmURL });
  sharedFfmpeg = ff;
  return ff;
}

// ---------------- inline MP4 mini-parser ---------------- //
type Box = { type: string; start: number; end: number; headerSize: number; size: number };

function u32(b: Uint8Array, o: number) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function u64(b: Uint8Array, o: number) {
  return u32(b, o) * 0x100000000 + u32(b, o + 4);
}
function i32(b: Uint8Array, o: number) {
  const v = u32(b, o);
  return v >= 0x80000000 ? v - 0x100000000 : v;
}
function fourcc(b: Uint8Array, o: number) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function topBoxes(buf: Uint8Array): Box[] {
  const out: Box[] = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    let size = u32(buf, o);
    const type = fourcc(buf, o + 4);
    let headerSize = 8;
    if (size === 1) {
      size = u64(buf, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = buf.length - o;
    }
    if (size < headerSize || o + size > buf.length) break;
    out.push({ type, start: o, end: o + size, headerSize, size });
    o += size;
  }
  return out;
}

function childBox(buf: Uint8Array, start: number, end: number, type: string): Box | null {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(buf, o);
    const t = fourcc(buf, o + 4);
    let headerSize = 8;
    if (size === 1) {
      size = u64(buf, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerSize || o + size > end) return null;
    if (t === type) return { type: t, start: o, end: o + size, headerSize, size };
    o += size;
  }
  return null;
}

function descend(buf: Uint8Array, root: Box, path: string[]): Box | null {
  let s = root.start + root.headerSize;
  let e = root.end;
  let cur: Box | null = null;
  for (const t of path) {
    const c = childBox(buf, s, e, t);
    if (!c) return null;
    cur = c;
    s = c.start + c.headerSize;
    e = c.end;
  }
  return cur;
}

export type ProbeResult = {
  ok: boolean;
  reasons: string[];
  rawWidth: number;
  rawHeight: number;
  displayWidth: number;
  displayHeight: number;
  rotationDeg: number;
  durationSeconds: number;
  videoCodec: string | null;
  audioCodec: string | null;
  moovBeforeMdat: boolean;
};

export function probeMp4(bytes: Uint8Array): ProbeResult {
  const reasons: string[] = [];
  const boxes = topBoxes(bytes);
  const ftyp = boxes.find((b) => b.type === "ftyp");
  const moov = boxes.find((b) => b.type === "moov");
  const mdat = boxes.find((b) => b.type === "mdat");
  const result: ProbeResult = {
    ok: false,
    reasons,
    rawWidth: 0,
    rawHeight: 0,
    displayWidth: 0,
    displayHeight: 0,
    rotationDeg: 0,
    durationSeconds: 0,
    videoCodec: null,
    audioCodec: null,
    moovBeforeMdat: false,
  };
  if (!ftyp || !moov || !mdat) {
    reasons.push("missing ftyp/moov/mdat");
    return result;
  }
  result.moovBeforeMdat = moov.start < mdat.start;
  if (!result.moovBeforeMdat) reasons.push("moov after mdat (faststart needed)");

  const mvhd = childBox(bytes, moov.start + moov.headerSize, moov.end, "mvhd");
  if (mvhd) {
    const version = bytes[mvhd.start + mvhd.headerSize];
    const p = mvhd.start + mvhd.headerSize + 4;
    const timescale = version === 1 ? u32(bytes, p + 16) : u32(bytes, p + 8);
    const duration = version === 1 ? u64(bytes, p + 20) : u32(bytes, p + 12);
    result.durationSeconds = timescale ? duration / timescale : 0;
    if (result.durationSeconds > 60.5) reasons.push(`duration ${result.durationSeconds.toFixed(2)}s exceeds 60s`);
  }

  // Walk traks
  let o = moov.start + moov.headerSize;
  while (o + 8 <= moov.end) {
    const size = u32(bytes, o);
    const type = fourcc(bytes, o + 4);
    const boxSize = size === 0 ? moov.end - o : size;
    if (type === "trak") {
      const trak: Box = { type, start: o, end: o + boxSize, headerSize: 8, size: boxSize };
      const hdlr = descend(bytes, trak, ["mdia", "hdlr"]);
      const stsd = descend(bytes, trak, ["mdia", "minf", "stbl", "stsd"]);
      const tkhd = descend(bytes, trak, ["tkhd"]);
      if (hdlr && stsd) {
        const handlerType = fourcc(bytes, hdlr.start + hdlr.headerSize + 8);
        const firstEntry = stsd.start + stsd.headerSize + 8;
        if (firstEntry + 8 <= stsd.end) {
          const codec = fourcc(bytes, firstEntry + 4);
          if (handlerType === "vide") {
            result.videoCodec = codec;
            if (tkhd) {
              const version = bytes[tkhd.start + tkhd.headerSize];
              const base = tkhd.start + tkhd.headerSize + 4;
              const preMatrix = version === 1 ? 32 : 20;
              const matrixOffset = base + preMatrix + 16;
              const widthOffset = matrixOffset + 36;
              const heightOffset = widthOffset + 4;
              const rawW = u32(bytes, widthOffset) / 65536;
              const rawH = u32(bytes, heightOffset) / 65536;
              const a = i32(bytes, matrixOffset) / 65536;
              const b = i32(bytes, matrixOffset + 4) / 65536;
              let rot = Math.round((Math.atan2(b, a) * 180) / Math.PI);
              if (rot < 0) rot += 360;
              const rotated = rot === 90 || rot === 270;
              result.rotationDeg = rot;
              result.rawWidth = Math.round(rawW);
              result.rawHeight = Math.round(rawH);
              result.displayWidth = rotated ? Math.round(rawH) : Math.round(rawW);
              result.displayHeight = rotated ? Math.round(rawW) : Math.round(rawH);
            }
          } else if (handlerType === "soun") {
            result.audioCodec = codec;
          }
        }
      }
    }
    if (boxSize < 8) break;
    o += boxSize;
  }

  if (result.displayHeight <= result.displayWidth)
    reasons.push(`not vertical (${result.displayWidth}x${result.displayHeight}, rot ${result.rotationDeg}°)`);
  if (result.videoCodec && result.videoCodec !== "avc1") reasons.push(`video codec ${result.videoCodec} (need avc1)`);
  if (result.audioCodec && result.audioCodec !== "mp4a") reasons.push(`audio codec ${result.audioCodec} (need mp4a)`);
  if (result.rotationDeg !== 0) reasons.push(`relies on ${result.rotationDeg}° rotation matrix`);

  result.ok = reasons.length === 0;
  return result;
}

// ---------------- ffmpeg re-encode ---------------- //

// Cover-style vertical 1080x1920: blurred zoomed background + centered subject,
// no black bars. Works for any input aspect (landscape, square, or vertical).
const COVER_FILTER =
  "[0:v]split=2[bg][fg];" +
  "[bg]scale=1080:1920:force_original_aspect_ratio=increase," +
  "crop=1080:1920,boxblur=luma_radius=30:luma_power=2,eq=brightness=-0.05[bgb];" +
  "[fg]scale=1080:1920:force_original_aspect_ratio=decrease,unsharp=3:3:0.4[fgs];" +
  "[bgb][fgs]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p,setsar=1";

export type PrepareOptions = {
  onProgress?: (pct: number, label: string) => void;
  onLog?: (msg: string) => void;
  forceConvert?: boolean;
};

export type PrepareResult = {
  file: Blob;
  reused: boolean;
  reason: string;
  sourceUrl: string;
  sourceFileSize: number;
  sourceProbe: ProbeResult;
  uploadFileSize: number;
  uploadProbe: ProbeResult;
};

function probeSummary(probe: ProbeResult, fileSize: number) {
  return {
    width: probe.rawWidth,
    height: probe.rawHeight,
    displayWidth: probe.displayWidth,
    displayHeight: probe.displayHeight,
    duration: Number(probe.durationSeconds.toFixed(3)),
    codec: [probe.videoCodec, probe.audioCodec].filter(Boolean).join("/") || "unknown",
    rotation: probe.rotationDeg,
    fileSize,
    moovBeforeMdat: probe.moovBeforeMdat,
    ok: probe.ok,
    reasons: probe.reasons,
  };
}

function isPhysicalPortraitShort(probe: ProbeResult) {
  const ratio = probe.rawWidth > 0 ? probe.rawHeight / probe.rawWidth : 0;
  return probe.rawHeight > probe.rawWidth && Math.abs(ratio - 16 / 9) < 0.03 && probe.rotationDeg === 0;
}

/**
 * Fetch a generated MP4 from `sourceUrl`, produce a YouTube-Shorts-ready Blob.
 * When the source already meets every Shorts requirement, returns the original
 * bytes (reused = true) and skips re-encoding entirely.
 */
export async function prepareShortsReadyBlob(
  sourceUrl: string,
  opts: PrepareOptions = {},
): Promise<PrepareResult> {
  const { onProgress, onLog, forceConvert } = opts;
  onProgress?.(2, "Fetching generated video…");
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Could not fetch source MP4 (HTTP ${res.status})`);
  const inputBytes = new Uint8Array(await res.arrayBuffer());
  console.info("[shorts-ready] Original generated MP4 details logged.", {
    sourceUrl,
    fileSize: inputBytes.byteLength,
  });

  onProgress?.(8, "Analyzing MP4 metadata…");
  console.info("[shorts-ready] Validation started.", { sourceUrl });
  const probe = probeMp4(inputBytes);
  console.info("[shorts-ready] Original file", probeSummary(probe, inputBytes.byteLength));
  const alreadyShort =
    !forceConvert &&
    probe.ok &&
    probe.rawWidth === 1080 &&
    probe.rawHeight === 1920 &&
    probe.displayWidth === 1080 &&
    probe.displayHeight === 1920 &&
    probe.rotationDeg === 0 &&
    probe.moovBeforeMdat;

  if (alreadyShort) {
    onProgress?.(100, "Already Shorts-ready — using original file");
    console.info("[shorts-ready] Upload-ready MP4 created.", probeSummary(probe, inputBytes.byteLength));
    console.info("[shorts-ready] Upload-ready MP4 validated.", { reused: true, valid: true });
    return {
      file: new Blob([inputBytes as BlobPart], { type: "video/mp4" }),
      reused: true,
      reason: "input already satisfies Shorts requirements",
      sourceUrl,
      sourceFileSize: inputBytes.byteLength,
      sourceProbe: probe,
      uploadFileSize: inputBytes.byteLength,
      uploadProbe: probe,
    };
  }

  onProgress?.(12, "Loading Shorts converter (ffmpeg)…");
  console.info("[shorts-ready] Conversion started.", {
    sourceUrl,
    reason: probe.reasons.join("; ") || "source is not exact 1080x1920 physical portrait faststart MP4",
  });
  const ff = await getFfmpeg(onLog);

  const inName = `in-${Date.now()}.mp4`;
  const outName = `out-${Date.now()}.mp4`;
  try {
    await ff.writeFile(inName, await fetchFile(new Blob([inputBytes as BlobPart], { type: "video/mp4" })));

    // Progress mapping — ffmpeg emits progress events (0..1) during encode.
    const off = ff.on("progress", ({ progress }: { progress: number }) => {
      const pct = Math.min(95, 15 + Math.max(0, Math.min(1, progress)) * 80);
      onProgress?.(pct, `Rendering vertical 1080×1920 (${Math.round(pct)}%)`);
    });

    // Single-pass encode: cover filter + H.264 high@4.1 + AAC 128k + faststart.
    // -noautorotate: input rotation matrix (if any) is baked into pixels by our
    // filter -> the output must NOT re-apply rotation metadata.
    await ff.exec([
      "-noautorotate",
      "-i", inName,
      "-vf", COVER_FILTER,
      "-c:v", "libx264",
      "-profile:v", "high",
      "-level", "4.1",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      "-metadata:s:v:0", "rotate=0",
      "-y", outName,
    ]);
    // Detach progress listener (fallback if the return isn't a function).
    try { (off as unknown as () => void)?.(); } catch { /* noop */ }

    const outData = await ff.readFile(outName);
    const outBytes = typeof outData === "string"
      ? new TextEncoder().encode(outData)
      : (outData as Uint8Array);

    // Post-encode validation. If anything's off, refuse the upload rather than
    // sending a possibly non-compliant file to YouTube.
    const recheck = probeMp4(outBytes);
    console.info("[shorts-ready] Conversion completed.", probeSummary(recheck, outBytes.byteLength));
    console.info("[shorts-ready] Converted file", probeSummary(recheck, outBytes.byteLength));
    if (
      !recheck.ok ||
      recheck.rawWidth !== 1080 ||
      recheck.rawHeight !== 1920 ||
      recheck.displayWidth !== 1080 ||
      recheck.displayHeight !== 1920 ||
      !isPhysicalPortraitShort(recheck) ||
      recheck.durationSeconds > 60.5
    ) {
      throw new Error(
        `Shorts-ready conversion output failed validation: ${recheck.reasons.join("; ")} ` +
          `(raw ${recheck.rawWidth}x${recheck.rawHeight}, display ${recheck.displayWidth}x${recheck.displayHeight}, rot ${recheck.rotationDeg}°, dur ${recheck.durationSeconds.toFixed(2)}s)`,
      );
    }

    onProgress?.(100, "Shorts-ready copy prepared");
    console.info("[shorts-ready] Upload-ready MP4 created.", probeSummary(recheck, outBytes.byteLength));
    console.info("[shorts-ready] Upload-ready MP4 validated.", { reused: false, valid: true });
    return {
      file: new Blob([outBytes as BlobPart], { type: "video/mp4" }),
      reused: false,
      reason: probe.reasons.join("; ") || "converted to true vertical 1080x1920",
      sourceUrl,
      sourceFileSize: inputBytes.byteLength,
      sourceProbe: probe,
      uploadFileSize: outBytes.byteLength,
      uploadProbe: recheck,
    };
  } finally {
    try { await ff.deleteFile(inName); } catch { /* noop */ }
    try { await ff.deleteFile(outName); } catch { /* noop */ }
  }
}
