// Pure-JS MP4 box inspector. Worker-safe (no ffmpeg, no native).
// Only reads what's needed to decide if a file will be recognized as a Short.

type Box = { type: string; start: number; size: number; headerSize: number; end: number };

function readUInt32(b: Uint8Array, o: number) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function readInt32(b: Uint8Array, o: number) {
  const v = readUInt32(b, o);
  return v >= 0x80000000 ? v - 0x100000000 : v;
}
function readUInt64(b: Uint8Array, o: number) {
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
  let contentStart = root.start + root.headerSize;
  let contentEnd = root.end;
  let current: Box | null = null;
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
  let o = ftyp.start + ftyp.headerSize + 8;
  while (o + 4 <= ftyp.end) {
    compatibleBrands.push(readType(buf, o));
    o += 4;
  }
  return { majorBrand, compatibleBrands };
}

function parseMvhd(buf: Uint8Array, mvhd: Box) {
  const version = buf[mvhd.start + mvhd.headerSize];
  const p = mvhd.start + mvhd.headerSize + 4;
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

export type TkhdInfo = {
  width: number;
  height: number;
  matrix: number[]; // 9 entries, first 6 are 16.16, last 3 are 2.30
  matrixOffset: number;
  widthOffset: number;
  heightOffset: number;
  rotationDeg: number;
  displayWidth: number;
  displayHeight: number;
};

function parseTkhd(buf: Uint8Array, tkhd: Box): TkhdInfo {
  const version = buf[tkhd.start + tkhd.headerSize];
  const base = tkhd.start + tkhd.headerSize + 4; // version+flags
  // v0: creation(4) mod(4) trackID(4) resv(4) duration(4) => 20, then resv(8) layer(2) alt(2) vol(2) resv(2) matrix(36) width(4) height(4)
  // v1: creation(8) mod(8) trackID(4) resv(4) duration(8) => 32
  const preMatrix = version === 1 ? 32 : 20;
  // after duration: reserved(8) + layer(2) + altGroup(2) + volume(2) + reserved(2) = 16
  const matrixOffset = base + preMatrix + 16;
  const matrix: number[] = [];
  for (let i = 0; i < 9; i += 1) matrix.push(readInt32(buf, matrixOffset + i * 4));
  const widthOffset = matrixOffset + 36;
  const heightOffset = widthOffset + 4;
  const width = readUInt32(buf, widthOffset) / 65536;
  const height = readUInt32(buf, heightOffset) / 65536;

  // Determine rotation from matrix. a=[0], b=[1], c=[3], d=[4] in 16.16.
  const a = matrix[0] / 65536;
  const b = matrix[1] / 65536;
  let rotationDeg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  if (rotationDeg < 0) rotationDeg += 360;

  const rotated = rotationDeg === 90 || rotationDeg === 270;
  const displayWidth = rotated ? Math.round(height) : Math.round(width);
  const displayHeight = rotated ? Math.round(width) : Math.round(height);

  return {
    width: Math.round(width),
    height: Math.round(height),
    matrix,
    matrixOffset,
    widthOffset,
    heightOffset,
    rotationDeg,
    displayWidth,
    displayHeight,
  };
}

function parseElstDurationTicks(buf: Uint8Array, elst: Box): number {
  const version = buf[elst.start + elst.headerSize];
  const p = elst.start + elst.headerSize + 4;
  const count = readUInt32(buf, p);
  let total = 0;
  let o = p + 4;
  for (let i = 0; i < count; i += 1) {
    if (version === 1) {
      total += readUInt64(buf, o);
      o += 20; // duration(8) media_time(8) rate(4)
    } else {
      total += readUInt32(buf, o);
      o += 12; // duration(4) media_time(4) rate(4)
    }
  }
  return total;
}

function findVideoAndAudioCodecs(buf: Uint8Array, moov: Box) {
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let videoTkhd: Box | null = null;
  let videoElst: Box | null = null;
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
      const elst = findDescendant(buf, trak, ["edts", "elst"]);
      if (hdlr && stsd) {
        const handlerType = readType(buf, hdlr.start + hdlr.headerSize + 8);
        const firstEntry = stsd.start + stsd.headerSize + 8;
        if (firstEntry + 8 <= stsd.end) {
          const codec = readType(buf, firstEntry + 4);
          if (handlerType === "vide") {
            videoCodec = codec;
            videoTkhd = tkhd;
            videoElst = elst;
          } else if (handlerType === "soun") {
            audioCodec = codec;
          }
        }
      }
    }
    if (boxSize < 8) break;
    o += boxSize;
  }
  return { videoCodec, audioCodec, videoTkhd, videoElst };
}

export type ShortsValidation = {
  ok: boolean;
  reasons: string[];
  needsFaststart: boolean;
  needsRemux: boolean;
  needsRotationFix: boolean;
  details: {
    majorBrand?: string;
    compatibleBrands?: string[];
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    rotationDeg?: number;
    durationSeconds?: number;
    elstDurationSeconds?: number;
    videoCodec?: string | null;
    audioCodec?: string | null;
    moovBeforeMdat?: boolean;
    fileSize?: number;
  };
};

export function validateShortsMp4(bytes: Uint8Array): ShortsValidation {
  const reasons: string[] = [];
  const boxes = readTopLevelBoxes(bytes);
  const ftyp = boxes.find((b) => b.type === "ftyp");
  const moov = boxes.find((b) => b.type === "moov");
  const mdat = boxes.find((b) => b.type === "mdat");

  const details: ShortsValidation["details"] = { fileSize: bytes.length };

  if (!ftyp) reasons.push("missing ftyp box (not a valid MP4)");
  if (!moov) reasons.push("missing moov box (not a valid MP4)");
  if (!mdat) reasons.push("missing mdat box (no media data)");

  let needsFaststart = false;
  let needsRemux = false;
  let needsRotationFix = false;

  if (ftyp) {
    const { majorBrand, compatibleBrands } = parseFtypBrands(bytes, ftyp);
    details.majorBrand = majorBrand;
    details.compatibleBrands = compatibleBrands;
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
    let mvhdSeconds = 0;
    let mvhdTimescale = 0;
    if (mvhd) {
      const { seconds, timescale } = parseMvhd(bytes, mvhd);
      mvhdSeconds = seconds;
      mvhdTimescale = timescale;
      details.durationSeconds = seconds;
      if (seconds > 60.5) {
        reasons.push(`duration ${seconds.toFixed(2)}s exceeds 60s Shorts limit`);
        needsRemux = true;
      }
    }
    const { videoCodec, audioCodec, videoTkhd, videoElst } = findVideoAndAudioCodecs(bytes, moov);
    details.videoCodec = videoCodec;
    details.audioCodec = audioCodec;
    if (videoTkhd) {
      const tk = parseTkhd(bytes, videoTkhd);
      details.width = tk.width;
      details.height = tk.height;
      details.displayWidth = tk.displayWidth;
      details.displayHeight = tk.displayHeight;
      details.rotationDeg = tk.rotationDeg;
      if (!(tk.displayHeight > tk.displayWidth)) {
        reasons.push(`video is not vertical (display ${tk.displayWidth}x${tk.displayHeight}, raw ${tk.width}x${tk.height}, rotation ${tk.rotationDeg}°)`);
        needsRemux = true;
      } else if (tk.rotationDeg !== 0) {
        // Pixels are landscape, matrix rotates to vertical. Some YouTube paths ignore rotation.
        reasons.push(`video relies on ${tk.rotationDeg}° rotation matrix (raw ${tk.width}x${tk.height}). Rewriting tkhd to declare vertical directly.`);
        needsRotationFix = true;
      }
    }
    if (videoElst && mvhdTimescale) {
      const ticks = parseElstDurationTicks(bytes, videoElst);
      const elstSeconds = ticks / mvhdTimescale;
      details.elstDurationSeconds = elstSeconds;
      if (elstSeconds > 60.5 && !reasons.some((r) => r.includes("exceeds 60s"))) {
        reasons.push(`edit list playback duration ${elstSeconds.toFixed(2)}s exceeds 60s Shorts limit`);
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
    void mvhdSeconds;
  }

  return {
    ok: reasons.length === 0,
    reasons,
    needsFaststart,
    needsRemux,
    needsRotationFix,
    details,
  };
}
