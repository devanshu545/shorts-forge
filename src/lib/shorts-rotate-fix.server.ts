// Pure-JS tkhd rewriter: rewrite the video track's transformation matrix to identity
// and swap the tkhd width/height when the file relies on a rotation matrix to display vertically.
// Rewrites happen in place on a copy; mdat sample data is never touched, so playback and
// visual quality are byte-identical.

import { readTopLevelBoxes, validateShortsMp4 } from "./shorts-validator.server";

type Box = { type: string; start: number; size: number; headerSize: number; end: number };

function readUInt32(b: Uint8Array, o: number) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function readUInt64(b: Uint8Array, o: number) {
  return readUInt32(b, o) * 0x100000000 + readUInt32(b, o + 4);
}
function writeUInt32(b: Uint8Array, o: number, v: number) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}
function readType(b: Uint8Array, o: number) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function findChild(buf: Uint8Array, start: number, end: number, type: string): Box | null {
  let o = start;
  while (o + 8 <= end) {
    let size = readUInt32(buf, o);
    const t = readType(buf, o + 4);
    let headerSize = 8;
    if (size === 1) {
      size = readUInt64(buf, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerSize || o + size > end) return null;
    if (t === type) return { type: t, start: o, size, headerSize, end: o + size };
    o += size;
  }
  return null;
}

function findDescendant(buf: Uint8Array, root: Box, path: string[]): Box | null {
  let s = root.start + root.headerSize;
  let e = root.end;
  let cur: Box | null = null;
  for (const t of path) {
    const c = findChild(buf, s, e, t);
    if (!c) return null;
    cur = c;
    s = c.start + c.headerSize;
    e = c.end;
  }
  return cur;
}

/**
 * If the video track's tkhd matrix rotates a landscape sample into vertical,
 * rewrite the matrix to identity and swap width/height so downstream classifiers
 * (like YouTube's Shorts shelf) that ignore the matrix see a vertical file.
 * Returns the input unchanged when no fix is needed.
 */
export function rotationFixMp4(input: Uint8Array): Uint8Array {
  const check = validateShortsMp4(input);
  if (!check.needsRotationFix) return input;

  const out = new Uint8Array(input); // copy; same length
  const boxes = readTopLevelBoxes(out);
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) return input;

  // Iterate traks and fix the vide track.
  let o = moov.start + moov.headerSize;
  const moovEnd = moov.end;
  while (o + 8 <= moovEnd) {
    const size = readUInt32(out, o);
    const type = readType(out, o + 4);
    const boxSize = size === 0 ? moovEnd - o : size;
    if (type === "trak") {
      const trak: Box = { type, start: o, size: boxSize, headerSize: 8, end: o + boxSize };
      const hdlr = findDescendant(out, trak, ["mdia", "hdlr"]);
      const tkhd = findDescendant(out, trak, ["tkhd"]);
      if (hdlr && tkhd) {
        const handlerType = readType(out, hdlr.start + hdlr.headerSize + 8);
        if (handlerType === "vide") {
          const version = out[tkhd.start + tkhd.headerSize];
          const base = tkhd.start + tkhd.headerSize + 4;
          const preMatrix = version === 1 ? 32 : 20;
          const matrixOffset = base + preMatrix + 16;
          const widthOffset = matrixOffset + 36;
          const heightOffset = widthOffset + 4;

          const w = readUInt32(out, widthOffset);
          const h = readUInt32(out, heightOffset);

          // Write identity matrix: {1,0,0, 0,1,0, 0,0,1} in {16.16, 16.16, 2.30}.
          const identity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
          for (let i = 0; i < 9; i += 1) writeUInt32(out, matrixOffset + i * 4, identity[i]);
          // Swap width/height so tkhd declares vertical directly.
          writeUInt32(out, widthOffset, h);
          writeUInt32(out, heightOffset, w);
        }
      }
    }
    if (boxSize < 8) break;
    o += boxSize;
  }

  return out;
}
