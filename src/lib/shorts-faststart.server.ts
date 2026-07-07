// Pure-JS qt-faststart: relocate moov to before mdat and rewrite stco/co64 offsets.
// Worker-safe, zero re-encode, no quality loss.

import { readTopLevelBoxes } from "./shorts-validator.server";

function readUInt32(b: Uint8Array, o: number) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function writeUInt32(b: Uint8Array, o: number, v: number) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}
function readUInt64(b: Uint8Array, o: number) {
  return readUInt32(b, o) * 0x100000000 + readUInt32(b, o + 4);
}
function writeUInt64(b: Uint8Array, o: number, v: number) {
  const hi = Math.floor(v / 0x100000000);
  const lo = v >>> 0;
  writeUInt32(b, o, hi);
  writeUInt32(b, o + 4, lo);
}
function readType(b: Uint8Array, o: number) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

// Walk every box in a subtree; on stco/co64, add `delta` to each offset entry.
function patchOffsets(buf: Uint8Array, start: number, end: number, delta: number) {
  let o = start;
  while (o + 8 <= end) {
    let size = readUInt32(buf, o);
    const type = readType(buf, o + 4);
    let headerSize = 8;
    if (size === 1) {
      size = readUInt64(buf, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerSize || o + size > end) return;
    const contentStart = o + headerSize;
    const contentEnd = o + size;

    if (type === "stco") {
      // version+flags(4) + entry_count(4) + entries * 4
      const entryCount = readUInt32(buf, contentStart + 4);
      let p = contentStart + 8;
      for (let i = 0; i < entryCount; i += 1) {
        writeUInt32(buf, p, (readUInt32(buf, p) + delta) >>> 0);
        p += 4;
      }
    } else if (type === "co64") {
      const entryCount = readUInt32(buf, contentStart + 4);
      let p = contentStart + 8;
      for (let i = 0; i < entryCount; i += 1) {
        writeUInt64(buf, p, readUInt64(buf, p) + delta);
        p += 8;
      }
    } else if (["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "udta"].includes(type)) {
      patchOffsets(buf, contentStart, contentEnd, delta);
    }

    o += size;
  }
}

/**
 * If the MP4 already has moov before mdat, returns the input unchanged.
 * Otherwise returns a new Uint8Array with moov relocated and offsets fixed.
 */
export function faststartMp4(input: Uint8Array): Uint8Array {
  const boxes = readTopLevelBoxes(input);
  const ftyp = boxes.find((b) => b.type === "ftyp");
  const moov = boxes.find((b) => b.type === "moov");
  const mdat = boxes.find((b) => b.type === "mdat");
  if (!ftyp || !moov || !mdat) return input;
  if (moov.start < mdat.start) return input;

  // Build output: [ftyp][moov(patched)][everything else in original order minus moov]
  const moovCopy = input.slice(moov.start, moov.end);
  // Delta = number of bytes moov moves forward relative to media offsets.
  // All mdat/etc. after moov's new position shift by +moov.size (moov is inserted before them).
  // Original stco offsets are absolute from file start; new absolute = old + moov.size.
  patchOffsets(moovCopy, moov.headerSize, moovCopy.length, moov.size);

  const out = new Uint8Array(input.length);
  let w = 0;
  // ftyp first (keep at very beginning; may or may not equal boxes[0])
  out.set(input.subarray(ftyp.start, ftyp.end), w);
  w += ftyp.size;
  // moov next
  out.set(moovCopy, w);
  w += moovCopy.length;
  // Then everything else in original order, skipping ftyp and moov
  for (const b of boxes) {
    if (b === ftyp || b === moov) continue;
    out.set(input.subarray(b.start, b.end), w);
    w += b.size;
  }
  return out;
}
