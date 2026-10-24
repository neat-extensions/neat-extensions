// GIF encoder (decoded back with an independent LZW decoder) and the Drive
// client against a fake Google Drive (status codes, chunking, retries, offline).
import { test, expect } from "@playwright/test";
import { buildPalette, createGifEncoder, inspectGif, lzw } from "../../apps/record/src/lib/gif.js";
import { createDrive, DriveError } from "../../apps/record/src/lib/drive.js";

/** Plain GIF LZW decoder, written from the spec (not from our encoder). */
function unlzw(blocks) {
  const minCode = blocks[0];
  const data = [];
  for (let p = 1; blocks[p]; p += blocks[p] + 1) data.push(...blocks.subarray(p + 1, p + 1 + blocks[p]));
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    size = minCode + 1;
  };
  reset();
  const out = [];
  let bit = 0;
  let prev = null;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++, bit++) v |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return v;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (code < dict.length) entry = dict[code];
    else entry = [...dict[prev], dict[prev][0]];
    out.push(...entry);
    if (prev !== null && dict.length < 4096) dict.push([...dict[prev], entry[0]]);
    if (dict.length === 1 << size && size < 12) size++;
    prev = code;
  }
  return out;
}

test.describe("GIF", () => {
  test("LZW round-trips through an independent decoder, including dictionary resets", () => {
    for (const n of [1, 2, 100, 5000, 120_000]) {
      const idx = new Uint8Array(n);
      let x = 7;
      for (let i = 0; i < n; i++) idx[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) % (i % 3 ? 7 : 256);
      expect(unlzw(lzw(idx)), `n=${n}`).toEqual([...idx]);
    }
  });

  test("palette has the real colours of a simple image", () => {
    const px = new Uint8Array(4 * 300);
    for (let i = 0; i < 300; i++) px.set(i < 100 ? [255, 0, 0, 255] : i < 200 ? [0, 255, 0, 255] : [0, 0, 255, 255], i * 4);
    const pal = buildPalette(px, 256);
    const colours = new Set();
    for (let i = 0; i < pal.length; i += 3) colours.add(`${pal[i]},${pal[i + 1]},${pal[i + 2]}`);
    expect(colours.has("255,0,0") && colours.has("0,255,0") && colours.has("0,0,255")).toBe(true);
  });

  test("an animated GIF with the right size, frame count and length", async () => {
    const w = 64;
    const h = 36;
    const parts = [];
    const frames = [];
    for (let f = 0; f < 12; f++) {
      const d = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) d.set([(i + f * 9) % 256, (f * 20) % 256, 128, 255], i * 4);
      frames.push(d);
    }
    const enc = createGifEncoder({ width: w, height: h, palette: buildPalette(frames[0]), sink: { write: async (u) => parts.push(Buffer.from(u)) } });
    for (const d of frames) await enc.addFrame(d, 10);
    await enc.finish();
    const gif = Buffer.concat(parts);
    expect(inspectGif(new Uint8Array(gif))).toEqual({ width: w, height: h, frames: 12, durationMs: 1200 });
  });
});

// ---------------------------------------------------------------- Drive
function fakeDrive({ failFirstUpload = false, expireToken = false, noPublicLinks = false, rangeless308 = false } = {}) {
  const calls = [];
  const uploaded = { length: 0, chunks: [] };
  let tokenExpired = expireToken;
  let failed = false;
  const res = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    calls.push(`${method} ${u.pathname}`);
    const auth = init.headers && init.headers.Authorization;
    if (u.pathname.startsWith("/session/")) {
      if (failFirstUpload && !failed) {
        failed = true;
        throw new TypeError("network");
      }
      const range = init.headers["Content-Range"];
      if (/^bytes \*\//.test(range)) return uploaded.length ? res(308, undefined, { Range: `bytes=0-${uploaded.length - 1}` }) : res(308);
      if (rangeless308) return res(308); // a broken server that never says how far it got
      const [, a, b, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range).map(Number);
      expect(a).toBe(uploaded.length);
      const chunk = new Uint8Array(await init.body.arrayBuffer());
      uploaded.chunks.push(chunk);
      uploaded.length += chunk.length;
      return b + 1 < total ? res(308, undefined, { Range: `bytes=0-${b}` }) : res(200, { id: "file1" });
    }
    if (auth !== "Bearer good") return res(401, { error: "invalid" });
    if (tokenExpired) {
      tokenExpired = false;
      return res(401, { error: "expired" });
    }
    if (method === "GET" && u.pathname === "/drive/v3/files") return res(200, { files: [] });
    if (method === "POST" && u.pathname === "/drive/v3/files") return res(200, { id: "folder1" });
    if (method === "POST" && u.pathname === "/upload/drive/v3/files") {
      expect(JSON.parse(init.body).parents).toEqual(["folder1"]);
      return res(200, {}, { Location: "https://www.googleapis.com/session/abc" });
    }
    if (method === "POST" && /permissions$/.test(u.pathname) && noPublicLinks) return res(403, { error: { errors: [{ reason: "publishOutNotPermitted" }] } });
    if (method === "POST" && /permissions$/.test(u.pathname)) {
      expect(JSON.parse(init.body)).toEqual({ role: "reader", type: "anyone" });
      return res(200, { id: "perm" });
    }
    if (method === "GET" && u.pathname === "/drive/v3/files/file1") return res(200, { webViewLink: "https://drive.google.com/file/d/file1/view" });
    return res(404, {});
  };
  return { f, calls, uploaded };
}

function drive(fake, { tokens = ["good"] } = {}) {
  const dropped = [];
  let folder = null;
  let i = 0;
  const d = createDrive({
    fetch: fake.f,
    getToken: async () => tokens[Math.min(i++, tokens.length - 1)],
    dropToken: async (t) => dropped.push(t),
    folderCache: { get: async () => folder, set: async (id) => (folder = id) },
  });
  return { d, dropped, folder: () => folder };
}

test.describe("Share to Drive", () => {
  const file = new Blob([new Uint8Array(20 * 1024 * 1024).map((_, i) => i % 251)], { type: "video/mp4" }); // 20 MB → 3 chunks

  test("creates the folder, uploads in chunks, shares by link", async () => {
    const fake = fakeDrive();
    const { d, folder } = drive(fake);
    const progress = [];
    const r = await d.share(file, "Neat Record test.mp4", (p) => progress.push(p));
    expect(r).toEqual({ id: "file1", link: "https://drive.google.com/file/d/file1/view", private: false });
    expect(fake.uploaded.length).toBe(file.size);
    expect(folder()).toBe("folder1");
    expect(progress.at(-1)).toBe(1);
    expect(fake.calls.filter((c) => c.startsWith("PUT")).length).toBe(3);
  });

  test("a revoked or expired token is dropped and asked for again once", async () => {
    const fake = fakeDrive({ expireToken: true });
    const { d, dropped } = drive(fake);
    await d.share(file, "x.mp4");
    expect(dropped).toEqual(["good"]);
  });

  test("still refused after a fresh token: a clear auth error", async () => {
    const fake = fakeDrive();
    const { d } = drive(fake, { tokens: ["bad"] });
    const e = await d.share(file, "x.mp4").catch((x) => x);
    expect(e).toBeInstanceOf(DriveError);
    expect(e.kind).toBe("auth");
  });

  test("offline: a clear message, no crash", async () => {
    const { d } = drive({
      f: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const e = await d.share(file, "x.mp4").catch((x) => x);
    expect(e.kind).toBe("offline");
    expect(e.message).toMatch(/offline/i);
  });

  test("an account that forbids public links: the upload is kept, the link is private, and we say so", async () => {
    const fake = fakeDrive({ noPublicLinks: true });
    const { d } = drive(fake);
    const r = await d.share(file, "x.mp4");
    expect(r).toMatchObject({ id: "file1", private: true });
    expect(fake.calls.filter((c) => c.startsWith("POST /upload")).length).toBe(1);
  });

  test("a server that never reports progress can't loop forever", async () => {
    const fake = fakeDrive({ rangeless308: true });
    const { d } = drive(fake);
    const e = await d.share(file, "x.mp4").catch((x) => x);
    expect(e).toBeInstanceOf(DriveError);
    expect(fake.calls.filter((c) => c.startsWith("PUT")).length).toBeLessThan(10);
  });

  test("a dropped connection mid-upload resumes from where Drive got to", async () => {
    const fake = fakeDrive({ failFirstUpload: true });
    const { d } = drive(fake);
    const r = await d.share(file, "x.mp4");
    expect(r.id).toBe("file1");
    expect(fake.uploaded.length).toBe(file.size);
  });
});
