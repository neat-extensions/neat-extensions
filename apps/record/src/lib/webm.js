// WebM repair. Chrome's MediaRecorder writes a "live" WebM: the Segment and
// every Cluster have unknown size, Info has no Duration and there are no Cues,
// so players show no length and cannot seek. fixWebm() rewrites it in two
// streaming passes with bounded memory: scan (cluster positions, timecodes,
// keyframes), then lay out EBML header → Segment (known size) → SeekHead → Info
// (with Duration) → Tracks → Cues → Clusters (known sizes) as a list of parts:
// new header bytes plus {start, end} ranges of the original, so the media data
// is never copied (see mp4.js). It can also trim to [startMs, endMs), starting
// at the keyframe cluster nearest startMs.
import { Reader, concat, putU64, writeParts } from "./bytes.js";

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  Void: 0xec,
  Tags: 0x1254c367,
};
const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, 0x1043a770, 0x1941a469]);
const UNKNOWN = -1;

async function readId(r, pos) {
  const b0 = (await r.bytes(pos, 1))[0];
  const len = b0 >= 0x80 ? 1 : b0 >= 0x40 ? 2 : b0 >= 0x20 ? 3 : b0 >= 0x10 ? 4 : 0;
  if (!len) throw new Error(`bad EBML id at ${pos}`);
  const b = await r.bytes(pos, len);
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[i];
  return { id, len };
}

async function readSize(r, pos) {
  const b0 = (await r.bytes(pos, 1))[0];
  let len = 1;
  while (len <= 8 && !(b0 & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error(`bad EBML size at ${pos}`);
  const b = await r.bytes(pos, len);
  let v = b0 & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[i];
    if (b[i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? UNKNOWN : v, len };
}

async function readHeader(r, pos) {
  const id = await readId(r, pos);
  const sz = await readSize(r, pos + id.len);
  return { id: id.id, start: pos, dataStart: pos + id.len + sz.len, size: sz.size };
}

const uint = (b) => b.reduce((v, x) => v * 256 + x, 0);

// ---------------------------------------------------------------- writing helpers
function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
  return Uint8Array.from(out);
}
function sizeBytes(n, width = 0) {
  let len = width || 1;
  while (!width && n >= 2 ** (7 * len) - 1) len++;
  const b = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    b[i] = v % 256;
    v = Math.floor(v / 256);
  }
  b[0] |= 0x80 >> (len - 1);
  return b;
}
const el = (id, data, width) => concat([idBytes(id), sizeBytes(data.length, width), data]);
function uintBytes(v, width) {
  const b = new Uint8Array(width);
  if (width === 8) putU64(b, 0, v);
  else for (let i = width - 1, x = v; i >= 0; i--, x = Math.floor(x / 256)) b[i] = x % 256;
  return b;
}
function floatBytes(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return b;
}

// ---------------------------------------------------------------- scan
/** Children of a cluster: [{id, start, dataStart, end}], stopping at the next level-1 element. */
async function clusterChildren(r, h, limit) {
  const end = h.size === UNKNOWN ? limit : Math.min(limit, h.dataStart + h.size);
  const kids = [];
  let p = h.dataStart;
  while (p < end) {
    let c;
    try {
      c = await readHeader(r, p);
    } catch {
      break; // garbage or a cut-off tail: stop at the last good element
    }
    if (h.size === UNKNOWN && LEVEL1.has(c.id)) break;
    if (c.size === UNKNOWN || c.dataStart + c.size > end) break;
    kids.push({ id: c.id, start: c.start, dataStart: c.dataStart, end: c.dataStart + c.size });
    p = c.dataStart + c.size;
  }
  return { kids, end: kids.length ? kids[kids.length - 1].end : h.dataStart };
}

async function blockInfo(r, kid) {
  let start = kid.dataStart;
  let key = false;
  if (kid.id === ID.BlockGroup) {
    // A Block inside a BlockGroup is a keyframe when the group has no ReferenceBlock.
    let p = kid.dataStart;
    let block = null;
    let refs = false;
    while (p < kid.end) {
      const c = await readHeader(r, p);
      if (c.id === ID.Block) block = c;
      if (c.id === ID.ReferenceBlock) refs = true;
      p = c.dataStart + c.size;
    }
    if (!block) return null;
    start = block.dataStart;
    key = !refs;
  }
  const tn = await readSize(r, start);
  const b = await r.bytes(start + tn.len, 3);
  const rel = (b[0] << 8) | b[1];
  if (kid.id === ID.SimpleBlock) key = (b[2] & 0x80) !== 0;
  return { track: tn.size, rel: rel >= 0x8000 ? rel - 0x10000 : rel, key };
}

export async function scanWebm(src) {
  const r = new Reader(src);
  const ebml = await readHeader(r, 0);
  if (ebml.id !== ID.EBML) throw new Error("not a WebM file");
  const seg = await readHeader(r, ebml.dataStart + ebml.size);
  if (seg.id !== ID.Segment) throw new Error("no Segment");
  const segEnd = seg.size === UNKNOWN ? src.size : Math.min(src.size, seg.dataStart + seg.size);
  const out = { ebmlEnd: seg.start, info: null, tracks: null, others: [], clusters: [], timecodeScale: 1_000_000, videoTrack: null, tracksByNumber: {}, duration: null, cuePoints: 0, knownSize: seg.size !== UNKNOWN };
  let p = seg.dataStart;
  while (p < segEnd) {
    let h;
    try {
      h = await readHeader(r, p);
    } catch {
      break;
    }
    if (h.id === ID.Cluster) {
      const { kids, end } = await clusterChildren(r, h, segEnd);
      if (h.size === UNKNOWN) out.unknownClusters = (out.unknownClusters || 0) + 1;
      const c = { start: h.start, dataStart: h.dataStart, end, timecode: 0, firstVideoKey: false, maxTime: -Infinity, videoTimes: [] };
      let sawVideo = false;
      for (const k of kids) {
        if (k.id === ID.Timecode) c.timecode = uint(await r.bytes(k.dataStart, k.end - k.dataStart));
        else if (k.id === ID.SimpleBlock || k.id === ID.BlockGroup) {
          const bi = await blockInfo(r, k);
          if (!bi) continue;
          const t = c.timecode + bi.rel;
          c.maxTime = Math.max(c.maxTime, t);
          if (bi.track === out.videoTrack) {
            if (!sawVideo) c.firstVideoKey = bi.key;
            sawVideo = true;
            if (c.videoTimes.length < 2 || out.clusters.length < 4) c.videoTimes.push(t);
          }
        }
      }
      if (out.videoTrack === null) c.firstVideoKey = true; // audio-only: every cluster is a cue point
      out.clusters.push(c);
      if (end <= h.dataStart) break;
      p = end;
      continue;
    }
    if (h.size === UNKNOWN) break;
    const end = h.dataStart + h.size;
    if (end > segEnd) break;
    if (h.id === ID.Info) {
      out.info = { start: h.start, dataStart: h.dataStart, end };
      let q = h.dataStart;
      while (q < end) {
        const c = await readHeader(r, q);
        if (c.id === ID.TimecodeScale) out.timecodeScale = uint(await r.bytes(c.dataStart, c.size));
        if (c.id === ID.Duration) {
          const b = (await r.bytes(c.dataStart, c.size)).slice();
          out.duration = c.size === 4 ? new DataView(b.buffer).getFloat32(0) : new DataView(b.buffer).getFloat64(0);
        }
        q = c.dataStart + c.size;
      }
    } else if (h.id === ID.Tracks) {
      out.tracks = { start: h.start, end };
      let q = h.dataStart;
      while (q < end) {
        const te = await readHeader(r, q);
        if (te.id === ID.TrackEntry) {
          let num = null;
          let type = null;
          let s = te.dataStart;
          while (s < te.dataStart + te.size) {
            const c = await readHeader(r, s);
            if (c.id === ID.TrackNumber) num = uint(await r.bytes(c.dataStart, c.size));
            if (c.id === ID.TrackType) type = uint(await r.bytes(c.dataStart, c.size));
            s = c.dataStart + c.size;
          }
          if (num !== null) out.tracksByNumber[num] = type === 1 ? "video" : type === 2 ? "audio" : "other";
          if (type === 1 && out.videoTrack === null) out.videoTrack = num;
        }
        q = te.dataStart + te.size;
      }
    } else if (h.id === ID.Cues) {
      for (let q = h.dataStart; q < end; ) {
        const c = await readHeader(r, q);
        if (c.id === 0xbb) out.cuePoints++;
        q = c.dataStart + c.size;
      }
    } else if (h.id !== ID.SeekHead && h.id !== ID.Void) {
      out.others.push({ start: h.start, end });
    }
    p = end;
  }
  if (!out.info || !out.tracks) throw new Error("WebM without Info/Tracks");
  return out;
}

/** Typical gap between video frames, to give the last frame a length. */
function frameGap(clusters) {
  const ts = clusters.flatMap((c) => c.videoTimes).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) gaps.push(ts[i] - ts[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
}

// ---------------------------------------------------------------- write
/**
 * @param src  source ({size, read})
 * @param opts { trim?: {startMs, endMs} }
 * @returns {Promise<{parts: Array<Uint8Array|{start:number,end:number}>, durationMs:number, cues:number, clusters:number, bytes:number}>}
 */
export async function planWebm(src, { trim = null } = {}) {
  const s = await scanWebm(src);
  const r = new Reader(src);
  const msPerTick = s.timecodeScale / 1e6;
  const toTicks = (ms) => ms / msPerTick;

  let clusters = s.clusters.filter((c) => c.maxTime > -Infinity);
  if (!clusters.length) throw new Error("too short: no video was recorded");
  let offset = 0;
  let endTick = Infinity;
  if (trim) {
    const startT = toTicks(Math.max(0, trim.startMs));
    endTick = toTicks(trim.endMs);
    // The keyframe cluster nearest the requested start (within half a keyframe gap).
    let first = 0;
    let best = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const d = Math.abs(clusters[i].timecode - startT);
      if (clusters[i].firstVideoKey && d < best) {
        best = d;
        first = i;
      }
    }
    offset = clusters[first].timecode;
    clusters = clusters.slice(first).filter((c) => c.timecode < endTick);
  }

  // Cluster bodies as parts: the original range, or (when trimming) a new Timecode plus
  // ranges of only the blocks inside the range. Media bytes are never held in memory.
  const bodies = [];
  let lastTime = 0;
  for (const c of clusters) {
    if (!trim) {
      bodies.push({ c, len: c.end - c.dataStart, parts: [{ start: c.dataStart, end: c.end }] });
      lastTime = Math.max(lastTime, c.maxTime);
      continue;
    }
    const { kids } = await clusterChildren(r, { dataStart: c.dataStart, size: c.end - c.dataStart }, c.end);
    const parts = [el(ID.Timecode, uintBytes(c.timecode - offset, 8))];
    let len = parts[0].length;
    for (const k of kids) {
      if (k.id === ID.Timecode) continue;
      if (k.id === ID.SimpleBlock || k.id === ID.BlockGroup) {
        const bi = await blockInfo(r, k);
        const t = bi ? c.timecode + bi.rel : 0;
        if (!bi || t >= endTick || t < offset) continue;
        lastTime = Math.max(lastTime, t - offset);
      }
      parts.push({ start: k.start, end: k.end });
      len += k.end - k.start;
    }
    bodies.push({ c, len, parts });
  }
  const durationTicks = lastTime + frameGap(clusters);

  // Info with Duration (any old Duration dropped), Tracks and other elements copied.
  const infoKids = [];
  for (let q = s.info.dataStart; q < s.info.end; ) {
    const c = await readHeader(r, q);
    if (c.id !== ID.Duration) infoKids.push((await r.bytes(c.start, c.dataStart + c.size - c.start)).slice());
    q = c.dataStart + c.size;
  }
  infoKids.push(el(ID.Duration, floatBytes(Math.max(0, durationTicks))));
  const info = el(ID.Info, concat(infoKids));
  const tracks = (await r.bytes(s.tracks.start, s.tracks.end - s.tracks.start)).slice();
  const others = [];
  for (const o of s.others) others.push((await r.bytes(o.start, o.end - o.start)).slice());

  // Cues: one point per cluster that starts with a video keyframe. Positions are fixed-width,
  // so the Cues size does not depend on where the clusters land.
  const cueTrack = s.videoTrack ?? Number(Object.keys(s.tracksByNumber)[0] || 1);
  const cueClusters = bodies.filter((b) => b.c.firstVideoKey);
  const cuePoint = (time, pos) => el(0xbb, concat([el(0xb3, uintBytes(time, 8)), el(0xb7, concat([el(0xf7, uintBytes(cueTrack, 1)), el(0xf1, uintBytes(pos, 8))]))]));
  const cuesLen = el(ID.Cues, concat(cueClusters.map(() => cuePoint(0, 0)))).length;

  const seekEntry = (id, pos) => el(0x4dbb, concat([el(0x53ab, idBytes(id)), el(0x53ac, uintBytes(pos, 8))]));
  const seekLen = el(ID.SeekHead, concat([seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), seekEntry(ID.Cues, 0)])).length;
  const infoPos = seekLen;
  const tracksPos = infoPos + info.length;
  const othersLen = others.reduce((n, o) => n + o.length, 0);
  const cuesPos = tracksPos + tracks.length + othersLen;
  let pos = cuesPos + cuesLen;
  const clusterPos = new Map();
  for (const b of bodies) {
    clusterPos.set(b, pos);
    pos += 12 + b.len; // 4-byte id + 8-byte size + body
  }
  const segmentSize = pos;
  const seek = el(ID.SeekHead, concat([seekEntry(ID.Info, infoPos), seekEntry(ID.Tracks, tracksPos), seekEntry(ID.Cues, cuesPos)]));
  const cues = el(ID.Cues, concat(cueClusters.map((b) => cuePoint(b.c.timecode - offset, clusterPos.get(b)))));

  const parts = [{ start: 0, end: s.ebmlEnd }, concat([idBytes(ID.Segment), sizeBytes(segmentSize, 8)]), seek, info, tracks, ...others, cues];
  for (const b of bodies) parts.push(concat([idBytes(ID.Cluster), sizeBytes(b.len, 8)]), ...b.parts);
  const bytes = s.ebmlEnd + 12 + segmentSize;
  return { parts, durationMs: durationTicks * msPerTick, cues: cueClusters.length, clusters: bodies.length, bytes };
}

/** planWebm, written out to a sink (tests, Node). */
export async function fixWebm(src, sink, opts = {}) {
  const plan = await planWebm(src, opts);
  await writeParts(src, plan.parts, sink);
  return { durationMs: plan.durationMs, cues: plan.cues, clusters: plan.clusters, bytes: plan.bytes };
}

/** Duration (ms), cue count and whether sizes are known — for tests and the post-fix self-check. */
export async function inspectWebm(src) {
  const s = await scanWebm(src);
  return { durationMs: s.duration === null ? null : (s.duration * s.timecodeScale) / 1e6, cuePoints: s.cuePoints, clusters: s.clusters.length, knownSize: s.knownSize, unknownClusters: s.unknownClusters || 0 };
}
