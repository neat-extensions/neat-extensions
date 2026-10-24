// Small animated-GIF encoder: one global 256-colour palette (median cut over
// sampled pixels), nearest-colour lookup through a 15-bit cache, LZW, and an
// infinite loop. Frames are RGBA (ImageData.data). Output goes to a sink as it
// is produced, so a long GIF never sits in memory twice.

/** Median-cut palette of up to `size` colours from RGBA samples. Returns Uint8Array(size*3). */
export function buildPalette(samples, size = 256) {
  const px = [];
  for (let i = 0; i < samples.length; i += 4) px.push((samples[i] << 16) | (samples[i + 1] << 8) | samples[i + 2]);
  let boxes = [px.length ? px : [0]];
  const ch = (c, k) => (c >> (16 - 8 * k)) & 255;
  while (boxes.length < size) {
    // Split the box with the widest channel range.
    let best = -1;
    let bestRange = 0;
    let bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let k = 0; k < 3; k++) {
        let lo = 255;
        let hi = 0;
        for (const c of b) {
          const v = ch(c, k);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          best = i;
          bestCh = k;
        }
      }
    });
    if (best < 0) break;
    const b = boxes[best].sort((a, c) => ch(a, bestCh) - ch(c, bestCh));
    const mid = b.length >> 1;
    boxes.splice(best, 1, b.slice(0, mid), b.slice(mid));
  }
  const pal = new Uint8Array(size * 3);
  boxes.forEach((b, i) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const c of b) {
      r += ch(c, 0);
      g += ch(c, 1);
      bl += ch(c, 2);
    }
    pal[i * 3] = Math.round(r / b.length);
    pal[i * 3 + 1] = Math.round(g / b.length);
    pal[i * 3 + 2] = Math.round(bl / b.length);
  });
  return pal;
}

function nearestMapper(pal) {
  const n = pal.length / 3;
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache[key];
    if (idx >= 0) return idx;
    let best = 1e9;
    for (let i = 0; i < n; i++) {
      const dr = pal[i * 3] - r;
      const dg = pal[i * 3 + 1] - g;
      const db = pal[i * 3 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    cache[key] = idx;
    return idx;
  };
}

/** GIF LZW for 8-bit indices → data sub-blocks. */
export function lzw(indices, minCode = 8) {
  const out = [];
  let cur = 0;
  let bits = 0;
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let next = eoi + 1;
  let dict = new Map();
  const emit = (code) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map();
      size = minCode + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  // Sub-blocks of at most 255 bytes, then a 0 terminator.
  const blocks = [minCode];
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    blocks.push(n);
    for (let j = 0; j < n; j++) blocks.push(out[i + j]);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

export function createGifEncoder({ width, height, palette, sink }) {
  const map = nearestMapper(palette);
  const le16 = (v) => [v & 255, (v >> 8) & 255];
  let started = false;
  const head = () =>
    Uint8Array.from([
      ...[71, 73, 70, 56, 57, 97], // GIF89a
      ...le16(width),
      ...le16(height),
      0xf7, // global colour table, 8 bits, 256 entries
      0,
      0,
      ...palette,
      ...[0x21, 0xff, 0x0b, ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0], // loop forever
    ]);
  return {
    async addFrame(rgba, delayCs) {
      if (!started) {
        await sink.write(head());
        started = true;
      }
      const idx = new Uint8Array(width * height);
      for (let i = 0, p = 0; i < idx.length; i++, p += 4) idx[i] = map(rgba[p], rgba[p + 1], rgba[p + 2]);
      await sink.write(Uint8Array.from([0x21, 0xf9, 4, 0x04, ...le16(Math.max(2, Math.round(delayCs))), 0, 0, 0x2c, 0, 0, 0, 0, ...le16(width), ...le16(height), 0]));
      await sink.write(lzw(idx));
    },
    async finish() {
      await sink.write(Uint8Array.from([0x3b]));
    },
  };
}

/** Read back a GIF's size and frame count (tests). */
export function inspectGif(b) {
  if (String.fromCharCode(...b.subarray(0, 6)) !== "GIF89a") return null;
  const width = b[6] | (b[7] << 8);
  const height = b[8] | (b[9] << 8);
  let p = 13 + (b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0);
  let frames = 0;
  let delayCs = 0;
  while (p < b.length) {
    const t = b[p];
    if (t === 0x3b) break;
    if (t === 0x21) {
      if (b[p + 1] === 0xf9) delayCs += b[p + 4] | (b[p + 5] << 8);
      p += 2;
      while (b[p]) p += b[p] + 1;
      p++;
    } else if (t === 0x2c) {
      frames++;
      const lct = b[p + 9] & 0x80 ? 3 * (1 << ((b[p + 9] & 7) + 1)) : 0;
      p += 10 + lct + 1;
      while (b[p]) p += b[p] + 1;
      p++;
    } else return null;
  }
  return { width, height, frames, durationMs: delayCs * 10 };
}
