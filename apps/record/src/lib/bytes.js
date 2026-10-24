// Random-access reading of a large file in bounded memory, and a few big-endian
// helpers. A source is { size, read(offset, length) → Promise<Uint8Array> }:
// an OPFS File in the extension, a Buffer in tests.

export function fileSource(file) {
  return { size: file.size, read: async (o, n) => new Uint8Array(await file.slice(o, o + n).arrayBuffer()) };
}

export function bufferSource(buf) {
  // A plain Uint8Array view, so .slice() copies (Node's Buffer.slice would alias).
  const u8 = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
  return { size: u8.length, read: async (o, n) => u8.subarray(o, Math.min(u8.length, o + n)) };
}

/** Keeps one window of the source in memory; reads past it slide the window. */
export class Reader {
  constructor(src, windowSize = 1 << 20) {
    this.src = src;
    this.size = src.size;
    this.windowSize = windowSize;
    this.start = 0;
    this.buf = new Uint8Array(0);
  }
  async bytes(pos, len) {
    if (pos < 0 || pos + len > this.size) throw new RangeError(`read past end (${pos}+${len} > ${this.size})`);
    if (pos < this.start || pos + len > this.start + this.buf.length) {
      this.start = pos;
      this.buf = await this.src.read(pos, Math.min(this.size - pos, Math.max(len, this.windowSize)));
    }
    return this.buf.subarray(pos - this.start, pos - this.start + len);
  }
}

/** Copies [from, to) of a source into a sink in chunks. */
export async function copyRange(src, sink, from, to, chunk = 4 << 20) {
  for (let p = from; p < to; p += chunk) await sink.write((await src.read(p, Math.min(chunk, to - p))).slice());
}

export const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
export const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
export function putU32(b, o, v) {
  b[o] = (v >>> 24) & 255;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
}
export function putU64(b, o, v) {
  putU32(b, o, Math.floor(v / 2 ** 32));
  putU32(b, o + 4, v % 2 ** 32);
}
export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Writes a list of parts — new bytes, or {start, end} ranges of the source — to a sink, in chunks. */
export async function writeParts(src, parts, sink) {
  for (const p of parts) {
    if (p instanceof Uint8Array) await sink.write(p);
    else await copyRange(src, sink, p.start, p.end);
  }
}

/** The same parts as one Blob: ranges become slices of the original file, so nothing is copied. */
export function partsToBlob(file, parts, type) {
  return new Blob(
    parts.map((p) => (p instanceof Uint8Array ? p : file.slice(p.start, p.end))),
    { type },
  );
}
