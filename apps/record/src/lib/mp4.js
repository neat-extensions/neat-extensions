// MP4 repair. Chrome's MediaRecorder writes fragmented MP4 (moov + moof/mdat
// pairs) with a zero duration in mvhd/tkhd/mdhd, no mehd and no mfra, so many
// players show 0:00 and seek slowly or not at all. planMp4() reads only the
// small boxes and returns the repaired file as a list of parts: new bytes
// (moov with real durations and an mehd, patched moofs, an mfra random-access
// index) and {start, end} ranges of the original (the media data, never
// copied). In the extension the parts become a Blob of file slices, so the
// repair needs no second copy on disk. Trimming keeps whole fragments: Chrome
// starts each fragment on a video keyframe.
import { Reader, concat, u32, u64, putU32, putU64, writeParts } from "./bytes.js";

const type = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

async function topBoxes(r) {
  const boxes = [];
  for (let p = 0; p + 8 <= r.size; ) {
    const h = await r.bytes(p, Math.min(16, r.size - p));
    let size = u32(h, 0);
    let hdr = 8;
    if (size === 1) {
      size = u64(h, 8);
      hdr = 16;
    } else if (size === 0) size = r.size - p;
    if (size < hdr || p + size > r.size) break; // cut-off tail: ignore it
    boxes.push({ type: type(h, 4), start: p, size, hdr });
    p += size;
  }
  return boxes;
}

/** Child boxes of an in-memory box payload. */
function children(b, from, to) {
  const out = [];
  for (let p = from; p + 8 <= to; ) {
    const size = u32(b, p);
    if (size < 8 || p + size > to) break;
    out.push({ type: type(b, p + 4), start: p, size });
    p += size;
  }
  return out;
}
const find = (b, from, to, t) => children(b, from, to).find((c) => c.type === t);
const findAll = (b, from, to, t) => children(b, from, to).filter((c) => c.type === t);

function parseMoov(m) {
  const mvhd = find(m, 8, m.length, "mvhd");
  const movieScale = m[mvhd.start + 8] === 1 ? u32(m, mvhd.start + 28) : u32(m, mvhd.start + 20);
  const tracks = [];
  for (const trak of findAll(m, 8, m.length, "trak")) {
    const tkhd = find(m, trak.start + 8, trak.start + trak.size, "tkhd");
    const id = m[tkhd.start + 8] === 1 ? u32(m, tkhd.start + 28) : u32(m, tkhd.start + 20);
    const mdia = find(m, trak.start + 8, trak.start + trak.size, "mdia");
    const mdhd = find(m, mdia.start + 8, mdia.start + mdia.size, "mdhd");
    const hdlr = find(m, mdia.start + 8, mdia.start + mdia.size, "hdlr");
    const scale = m[mdhd.start + 8] === 1 ? u32(m, mdhd.start + 28) : u32(m, mdhd.start + 20);
    tracks.push({ id, scale, handler: hdlr ? type(m, hdlr.start + 16) : "", tkhd, mdhd, trex: { duration: 0, flags: 0 } });
  }
  const mvex = find(m, 8, m.length, "mvex");
  if (mvex) {
    for (const trex of findAll(m, mvex.start + 8, mvex.start + mvex.size, "trex")) {
      const t = tracks.find((x) => x.id === u32(m, trex.start + 12));
      if (t) t.trex = { duration: u32(m, trex.start + 20), flags: u32(m, trex.start + 28) };
    }
  }
  return { mvhd, movieScale, tracks, mvex };
}

const NON_SYNC = 0x10000;

/** Per traf: track, decode time, total duration, index of the first sync sample (1-based) and where tfdt / base offset live. */
function parseMoof(b, tracks) {
  const trafs = [];
  for (const traf of findAll(b, 8, b.length, "traf")) {
    const end = traf.start + traf.size;
    const tfhd = find(b, traf.start + 8, end, "tfhd");
    const flags = u32(b, tfhd.start + 8) & 0xffffff;
    const id = u32(b, tfhd.start + 12);
    let o = tfhd.start + 16;
    let baseOffsetAt = null;
    if (flags & 0x1) {
      baseOffsetAt = o;
      o += 8;
    }
    if (flags & 0x2) o += 4;
    const t = tracks.find((x) => x.id === id) || { trex: { duration: 0, flags: 0 } };
    const defDur = flags & 0x8 ? u32(b, o) : t.trex.duration;
    if (flags & 0x8) o += 4;
    if (flags & 0x10) o += 4;
    const defFlags = flags & 0x20 ? u32(b, o) : t.trex.flags;
    const tfdt = find(b, traf.start + 8, end, "tfdt");
    const tfdtV1 = tfdt && b[tfdt.start + 8] === 1;
    const time = tfdt ? (tfdtV1 ? u64(b, tfdt.start + 12) : u32(b, tfdt.start + 12)) : null;
    let dur = 0;
    let count = 0;
    let firstSync = 0;
    for (const trun of findAll(b, traf.start + 8, end, "trun")) {
      const tf = u32(b, trun.start + 8) & 0xffffff;
      const n = u32(b, trun.start + 12);
      let q = trun.start + 16;
      if (tf & 0x1) q += 4;
      let firstFlags = null;
      if (tf & 0x4) {
        firstFlags = u32(b, q);
        q += 4;
      }
      for (let i = 0; i < n; i++) {
        let d = defDur;
        let f = i === 0 && firstFlags !== null ? firstFlags : defFlags;
        if (tf & 0x100) {
          d = u32(b, q);
          q += 4;
        }
        if (tf & 0x200) q += 4;
        if (tf & 0x400) {
          f = u32(b, q);
          q += 4;
        }
        if (tf & 0x800) q += 4;
        count++;
        if (!firstSync && !(f & NON_SYNC)) firstSync = count;
        dur += d;
      }
    }
    trafs.push({ id, time, dur, firstSync, tfdtAt: tfdt ? tfdt.start + 12 : null, tfdtV1, baseOffsetAt });
  }
  return trafs;
}

function setDuration(m, box, value, v1Offset, v0Offset) {
  if (m[box.start + 8] === 1) putU64(m, box.start + v1Offset, value);
  else putU32(m, box.start + v0Offset, Math.min(0xffffffff, value));
}

/**
 * @param src  source ({size, read})
 * @param opts { trim?: {startMs, endMs} }
 * @returns {Promise<{parts: Array<Uint8Array|{start:number,end:number}>, durationMs:number, fragments:number, bytes:number}>}
 */
export async function planMp4(src, { trim = null } = {}) {
  const r = new Reader(src, 64 * 1024); // headers only: a small window, the media data is never read
  const boxes = await topBoxes(r);
  const moovBox = boxes.find((b) => b.type === "moov");
  if (!moovBox || boxes[0].type !== "ftyp") throw new Error("not an MP4 file");
  const moov = (await r.bytes(moovBox.start, moovBox.size)).slice();
  const mv = parseMoov(moov);
  const video = mv.tracks.find((t) => t.handler === "vide") || mv.tracks[0];

  // Fragments: a moof and the mdat that follows it. A traf without tfdt continues from the previous one.
  const frags = [];
  const running = {};
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].type !== "moof") continue;
    const moof = boxes[i];
    const mdat = boxes[i + 1] && boxes[i + 1].type === "mdat" ? boxes[i + 1] : null;
    if (!mdat) continue; // a moof without data (cut-off tail) is dropped
    const bytes = (await r.bytes(moof.start, moof.size)).slice();
    const trafs = parseMoof(bytes, mv.tracks);
    for (const tf of trafs) {
      if (tf.time === null) tf.time = running[tf.id] || 0;
      running[tf.id] = tf.time + tf.dur;
    }
    frags.push({ moof, mdat, bytes, trafs });
  }
  if (!frags.length) throw new Error("too short: no video was recorded");
  const vt = (f) => f.trafs.find((t) => t.id === video.id);

  let keep = frags;
  if (trim) {
    const sec = (f) => (vt(f) ? vt(f).time / video.scale : 0);
    // Start at the keyframe fragment nearest the requested start; end at the nearest
    // fragment boundary. Chrome starts a fragment on every keyframe (we ask for one a
    // second), so both ends land within half a second of what was asked.
    let first = 0;
    let best = Infinity;
    frags.forEach((f, i) => {
      const d = Math.abs(sec(f) * 1000 - trim.startMs);
      if (vt(f) && vt(f).firstSync === 1 && d < best) {
        best = d;
        first = i;
      }
    });
    const durMs = (f) => (vt(f) ? (vt(f).dur / video.scale) * 1000 : 0);
    keep = frags.slice(first).filter((f, i) => i === 0 || sec(f) * 1000 + durMs(f) / 2 < trim.endMs);
  }
  // One offset, in seconds, for every track, so audio and video stay in sync.
  let offsetSec = 0;
  if (trim) {
    offsetSec = Infinity;
    for (const t of mv.tracks) {
      const tf = keep.map((f) => f.trafs.find((x) => x.id === t.id)).find(Boolean);
      if (tf) offsetSec = Math.min(offsetSec, tf.time / t.scale);
    }
    if (!Number.isFinite(offsetSec)) offsetSec = 0;
  }
  const startOf = Object.fromEntries(mv.tracks.map((t) => [t.id, Math.round(offsetSec * t.scale)]));

  // Durations per track (media timescale) and for the movie (movie timescale).
  const trackDur = {};
  for (const t of mv.tracks) {
    let end = 0;
    for (const f of keep) for (const tf of f.trafs) if (tf.id === t.id) end = Math.max(end, tf.time - startOf[t.id] + tf.dur);
    trackDur[t.id] = end;
  }
  const movieDur = Math.max(0, ...mv.tracks.map((t) => Math.round((trackDur[t.id] / t.scale) * mv.movieScale)));
  setDuration(moov, mv.mvhd, movieDur, 32, 24);
  for (const t of mv.tracks) {
    setDuration(moov, t.tkhd, Math.round((trackDur[t.id] / t.scale) * mv.movieScale), 36, 28);
    setDuration(moov, t.mdhd, trackDur[t.id], 32, 24);
  }

  // mehd (fragment duration) as the first child of mvex; replaces an existing one.
  let newMoov = moov;
  if (mv.mvex) {
    const kids = children(moov, mv.mvex.start + 8, mv.mvex.start + mv.mvex.size).filter((c) => c.type !== "mehd");
    const mehd = new Uint8Array(20);
    putU32(mehd, 0, 20);
    mehd.set([109, 101, 104, 100], 4); // "mehd"
    mehd[8] = 1;
    putU64(mehd, 12, movieDur);
    const body = concat([mehd, ...kids.map((c) => moov.subarray(c.start, c.start + c.size))]);
    const mvex = concat([new Uint8Array(8), body]);
    putU32(mvex, 0, mvex.length);
    mvex.set([109, 118, 101, 120], 4);
    newMoov = concat([moov.subarray(0, mv.mvex.start), mvex, moov.subarray(mv.mvex.start + mv.mvex.size)]);
    putU32(newMoov, 0, newMoov.length);
  }

  const parts = [];
  let pos = 0;
  const add = (p) => {
    parts.push(p);
    pos += p instanceof Uint8Array ? p.length : p.end - p.start;
  };
  // ftyp, the new moov, and any other top-level box before the first fragment (old index boxes dropped).
  const firstFrag = frags[0].moof.start;
  for (const b of boxes) {
    if (b.start >= firstFrag) break;
    if (b.type === "moov") add(newMoov);
    else if (b.type !== "mfra" && b.type !== "free" && b.type !== "skip") add({ start: b.start, end: b.start + b.size });
  }

  const tfra = Object.fromEntries(mv.tracks.map((t) => [t.id, []]));
  let seq = 0;
  for (const f of keep) {
    const moofPos = pos;
    const shift = moofPos - f.moof.start;
    const bytes = f.bytes;
    seq++;
    const mfhd = find(bytes, 8, bytes.length, "mfhd");
    if (mfhd) putU32(bytes, mfhd.start + 12, seq);
    f.trafs.forEach((tf, i) => {
      if (tf.baseOffsetAt !== null) putU64(bytes, tf.baseOffsetAt, u64(bytes, tf.baseOffsetAt) + shift);
      const t = tf.time - (startOf[tf.id] || 0);
      if (trim && tf.tfdtAt !== null) {
        if (tf.tfdtV1) putU64(bytes, tf.tfdtAt, t);
        else putU32(bytes, tf.tfdtAt, t);
      }
      if (tf.firstSync && tfra[tf.id]) tfra[tf.id].push({ time: t, moof: moofPos, traf: i + 1, sample: tf.firstSync });
    });
    add(bytes);
    add({ start: f.mdat.start, end: f.mdat.start + f.mdat.size });
  }

  // mfra: one tfra per track (version 1: 64-bit time and offset, 1-byte traf/trun/sample numbers), then mfro.
  const tfras = mv.tracks.map((t) => {
    const e = tfra[t.id];
    const b = new Uint8Array(24 + e.length * 19);
    putU32(b, 0, b.length);
    b.set([116, 102, 114, 97], 4); // "tfra"
    b[8] = 1;
    putU32(b, 12, t.id);
    putU32(b, 16, 0); // 1-byte traf_number, trun_number, sample_number
    putU32(b, 20, e.length);
    e.forEach((x, i) => {
      const o = 24 + i * 19;
      putU64(b, o, x.time);
      putU64(b, o + 8, x.moof);
      b[o + 16] = Math.min(255, x.traf);
      b[o + 17] = 1;
      b[o + 18] = Math.min(255, x.sample);
    });
    return b;
  });
  const mfraLen = 8 + tfras.reduce((n, b) => n + b.length, 0) + 16;
  const head = new Uint8Array(8);
  putU32(head, 0, mfraLen);
  head.set([109, 102, 114, 97], 4); // "mfra"
  const mfro = new Uint8Array(16);
  putU32(mfro, 0, 16);
  mfro.set([109, 102, 114, 111], 4); // "mfro"
  putU32(mfro, 12, mfraLen);
  add(concat([head, ...tfras, mfro]));

  return { parts, durationMs: (movieDur / mv.movieScale) * 1000, fragments: keep.length, bytes: pos };
}

/** planMp4, written out to a sink (tests, Node). */
export async function fixMp4(src, sink, opts = {}) {
  const plan = await planMp4(src, opts);
  await writeParts(src, plan.parts, sink);
  return { durationMs: plan.durationMs, fragments: plan.fragments, bytes: plan.bytes };
}

/** Read back the durations and index of a (fixed) MP4: used by tests and as a self-check after fixing. */
export async function inspectMp4(src) {
  const r = new Reader(src);
  const boxes = await topBoxes(r);
  const moovBox = boxes.find((b) => b.type === "moov");
  const moov = (await r.bytes(moovBox.start, moovBox.size)).slice();
  const mv = parseMoov(moov);
  const mvhdDur = moov[mv.mvhd.start + 8] === 1 ? u64(moov, mv.mvhd.start + 32) : u32(moov, mv.mvhd.start + 24);
  const mvex = find(moov, 8, moov.length, "mvex");
  const mehd = mvex && find(moov, mvex.start + 8, mvex.start + mvex.size, "mehd");
  const mfra = boxes.find((b) => b.type === "mfra");
  let tfraEntries = 0;
  if (mfra) {
    const m = await r.bytes(mfra.start, mfra.size);
    for (const t of findAll(m, 8, m.length, "tfra")) tfraEntries += u32(m, t.start + 20);
  }
  return { durationMs: (mvhdDur / mv.movieScale) * 1000, hasMehd: !!mehd, hasMfra: !!mfra, tfraEntries, fragments: boxes.filter((b) => b.type === "moof").length, tracks: mv.tracks.map((t) => t.handler) };
}
