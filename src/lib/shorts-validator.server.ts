// Pure-JS MP4 box inspector. Worker-safe (no ffmpeg, no native).
// Only reads what's needed to decide if a file will be recognized as a Short.

type Box = { type: string; start: number; size: number; headerSize: number; end: number };

function readUInt32(b: Uint8Array, o: number) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function readUInt64(b: Uint8Array, o: number) {
  // Safe for MP4 sizes we care about (< 2^53).
  const hi = readUInt32(b, o);
  const lo = readUInt32(b, o + 4);
  return hi * 0x100000000 + lo;
}
function readType(b: Uint8Array, o: number) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

export function readTopLevelBoxes(buf: Uint8Array, limit = buf.length): Box[] {
  const boxes: Box[] = [];
  let o = 0;
  while (o + 8 <= limit) {
    let size = readUInt32(buf, o);
    const type = readType(buf, o + 4);
    let headerSize = 8;
    if (size === 1) {
      if (o + 16 > limit) break;
      size = readUInt64(buf, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = limit - o;
    }
    if (size < headerSize || o + size > buf.length) break;
    boxes.push({ type, start: o, size, headerSize, end: o + size });
    o += size;
  }
  return boxes;
}

function findChildBox(buf: Uint8Array, parentStart: number, parentEnd: number, type: string): Box | null {
  let o = parentStart;
  while (o + 8 <= parentEnd) {
    let size = readUInt32(buf, o);
    const t = readType(buf, o + 4);
    let headerSize = 8;
    if (size === 1) {
      size = readUInt64(buf, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = parentEnd - o;
    }
    if (size < headerSize || o + size > parentEnd) return null;
    if (t === type) return { type: t, start: o, size, headerSize, end: o + size };
    o += size;
  }
  return null;
}

function findDescendant(buf: Uint8Array, root: Box, path: string[]): Box | null {
  let current: Box | null = root;
  let contentStart = root.start + root.headerSize;
  let contentEnd = root.end;
  for (const type of path) {
    const child = findChildBox(buf, contentStart, contentEnd, type);
    if (!child) return null;
    current = child;
    contentStart = child.start + child.headerSize;
    contentEnd = child.end;
  }
  return current;
}

function parseFtypBrands(buf: Uint8Array, ftyp: Box) {
  const majorBrand = readType(buf, ftyp.start + ftyp.headerSize);
  const compatibleBrands: string[] = [];
  let o = ftyp.start + ftyp.headerSize + 8; // major(4) + minor(4)
  while (o + 4 <= ftyp.end) {
    compatibleBrands.push(readType(buf, o));
    o += 4;
  }
  return { majorBrand, compatibleBrands };
}

function parseMvhd(buf: Uint8Array, mvhd: Box) {
  const version = buf[mvhd.start + mvhd.headerSize];
  const p = mvhd.start + mvhd.headerSize + 4; // version+flags
  let timescale: number;
  let duration: number;
  if (version === 1) {
    timescale = readUInt32(buf, p + 16);
    duration = readUInt64(buf, p + 20);
  } else {
    timescale = readUInt32(buf, p + 8);
    duration = readUInt32(buf, p + 12);
  }
  return { timescale, duration, seconds: timescale ? duration / timescale : 0 };
}

function parseTkhdDims(buf: Uint8Array, tkhd: Box) {
  const version = buf[tkhd.start + tkhd.headerSize];
  const end = tkhd.end;
  // width/height are the last 8 bytes of tkhd (16.16 fixed point)
  const wOff = end - 8;
  const hOff = end - 4;
  const w = readUInt32(buf, wOff) / 65536;
  const h = readUInt32(buf, hOff) / 65536;
  return { width: Math.round(w), height: Math.round(h), version };
}

function findVideoAndAudioCodecs(buf: Uint8Array, moov: Box) {
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let videoTkhd: Box | null = null;
  // Iterate trak children of moov
  let o = moov.start + moov.headerSize;
  const moovEnd = moov.end;
  while (o + 8 <= moovEnd) {
    const size = readUInt32(buf, o);
    const type = readType(buf, o + 4);
    const boxSize = size === 0 ? moovEnd - o : size;
    if (type === "trak") {
      const trak: Box = { type, start: o, size: boxSize, headerSize: 8, end: o + boxSize };
      const hdlr = findDescendant(buf, trak, ["mdia", "hdlr"]);
      const stsd = findDescendant(buf, trak, ["mdia", "minf", "stbl", "stsd"]);
      const tkhd = findDescendant(buf, trak, ["tkhd"]);
      if (hdlr && stsd) {
        const handlerType = readType(buf, hdlr.start + hdlr.headerSize + 8);
        // stsd: version+flags(4) + entry_count(4) + entries...
        const firstEntry = stsd.start + stsd.headerSize + 8;
        if (firstEntry + 8 <= stsd.end) {
          const codec = readType(buf, firstEntry + 4);
          if (handlerType === "vide") {
            videoCodec = codec;
            videoTkhd = tkhd;
          } else if (handlerType === "soun") {
            audioCodec = codec;
          }
        }
      }
    }
    if (boxSize < 8) break;
    o += boxSize;
  }
  return { videoCodec, audioCodec, videoTkhd };
}

export type ShortsValidation = {
  ok: boolean;
  reasons: string[];
  needsFaststart: boolean;
  needsRemux: boolean;
  details: {
    majorBrand?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
    videoCodec?: string | null;
    audioCodec?: string | null;
    moovBeforeMdat?: boolean;
  };
};

export function validateShortsMp4(bytes: Uint8Array): ShortsValidation {
  const reasons: string[] = [];
  const boxes = readTopLevelBoxes(bytes);
  const ftyp = boxes.find((b) => b.type === "ftyp");
  const moov = boxes.find((b) => b.type === "moov");
  const mdat = boxes.find((b) => b.type === "mdat");

  const details: ShortsValidation["details"] = {};

  if (!ftyp) reasons.push("missing ftyp box (not a valid MP4)");
  if (!moov) reasons.push("missing moov box (not a valid MP4)");
  if (!mdat) reasons.push("missing mdat box (no media data)");

  let needsFaststart = false;
  let needsRemux = false;

  if (ftyp) {
    const { majorBrand, compatibleBrands } = parseFtypBrands(bytes, ftyp);
    details.majorBrand = majorBrand;
    const allBrands = [majorBrand, ...compatibleBrands];
    const okBrand = allBrands.some((b) => ["isom", "mp42", "mp41", "iso2", "iso5", "iso6", "avc1", "dash"].includes(b));
    if (!okBrand) {
      reasons.push(`unsupported MP4 brand: ${majorBrand}`);
      needsRemux = true;
    }
  }

  if (moov && mdat) {
    const moovBeforeMdat = moov.start < mdat.start;
    details.moovBeforeMdat = moovBeforeMdat;
    if (!moovBeforeMdat) {
      reasons.push("moov atom is after mdat (needs faststart)");
      needsFaststart = true;
    }
  }

  if (moov) {
    const mvhd = findChildBox(bytes, moov.start + moov.headerSize, moov.end, "mvhd");
    if (mvhd) {
      const { seconds } = parseMvhd(bytes, mvhd);
      details.durationSeconds = seconds;
      if (seconds > 60.5) {
        reasons.push(`duration ${seconds.toFixed(2)}s exceeds 60s Shorts limit`);
        needsRemux = true;
      }
    }
    const { videoCodec, audioCodec, videoTkhd } = findVideoAndAudioCodecs(bytes, moov);
    details.videoCodec = videoCodec;
    details.audioCodec = audioCodec;
    if (videoTkhd) {
      const { width, height } = parseTkhdDims(bytes, videoTkhd);
      details.width = width;
      details.height = height;
      if (!(height > width)) {
        reasons.push(`video is not vertical (${width}x${height})`);
        needsRemux = true;
      }
    }
    if (videoCodec && !["avc1", "hvc1", "hev1", "av01", "vp09"].includes(videoCodec)) {
      reasons.push(`unsupported video codec: ${videoCodec}`);
      needsRemux = true;
    }
    if (audioCodec && !["mp4a", "Opus", "opus", "ac-3", "ec-3"].includes(audioCodec)) {
      reasons.push(`unsupported audio codec: ${audioCodec}`);
      needsRemux = true;
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    needsFaststart,
    needsRemux,
    details,
  };
}
