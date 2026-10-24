// Container repair: Chrome's MediaRecorder output (fixtures recorded by
// tests/fixtures/record/make-fixtures.mjs) has no duration and no seek index.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bufferSource } from "../../apps/record/src/lib/bytes.js";
import { fixWebm, inspectWebm } from "../../apps/record/src/lib/webm.js";
import { fixMp4, inspectMp4 } from "../../apps/record/src/lib/mp4.js";

const FIX = path.join(import.meta.dirname, "..", "fixtures", "record");
const rawWebm = readFileSync(path.join(FIX, "raw.webm"));
const rawMp4 = readFileSync(path.join(FIX, "raw.mp4"));

function sink() {
  const parts = [];
  return { write: async (u) => parts.push(Buffer.from(u)), bytes: () => Buffer.concat(parts) };
}

test.describe("WebM repair", () => {
  test("the raw recording really is broken", async () => {
    const i = await inspectWebm(bufferSource(rawWebm));
    expect(i.durationMs).toBeNull();
    expect(i.cuePoints).toBe(0);
    expect(i.knownSize).toBe(false);
    expect(i.unknownClusters).toBeGreaterThan(0);
  });

  test("fixed: duration, cues, known sizes, nothing lost", async () => {
    const out = sink();
    const r = await fixWebm(bufferSource(rawWebm), out);
    const i = await inspectWebm(bufferSource(out.bytes()));
    expect(i.durationMs).toBeGreaterThan(3000);
    expect(i.durationMs).toBeLessThan(3600);
    expect(Math.abs(i.durationMs - r.durationMs)).toBeLessThan(1);
    expect(i.cuePoints).toBeGreaterThanOrEqual(3); // one per keyframe cluster, keyframes every second
    expect(i.knownSize).toBe(true);
    expect(i.unknownClusters).toBe(0);
    expect(i.clusters).toBe((await inspectWebm(bufferSource(rawWebm))).clusters);
    expect(out.bytes().length).toBeGreaterThan(rawWebm.length); // only headers and an index added
    expect(out.bytes().length - rawWebm.length).toBeLessThan(2048);
  });

  test("fixing a fixed file changes nothing that matters", async () => {
    const a = sink();
    await fixWebm(bufferSource(rawWebm), a);
    const b = sink();
    await fixWebm(bufferSource(a.bytes()), b);
    const ia = await inspectWebm(bufferSource(a.bytes()));
    const ib = await inspectWebm(bufferSource(b.bytes()));
    expect(ib).toEqual(ia);
  });

  test("a recording cut off mid-cluster (crash, full disk) still repairs", async () => {
    const cut = rawWebm.subarray(0, Math.floor(rawWebm.length * 0.7));
    const out = sink();
    await fixWebm(bufferSource(cut), out);
    const i = await inspectWebm(bufferSource(out.bytes()));
    expect(i.durationMs).toBeGreaterThan(1000);
    expect(i.durationMs).toBeLessThan(3000);
  });

  test("trim keeps a keyframe start and the requested end", async () => {
    const out = sink();
    const r = await fixWebm(bufferSource(rawWebm), out, { trim: { startMs: 1200, endMs: 2500 } });
    const i = await inspectWebm(bufferSource(out.bytes()));
    // Starts at the keyframe nearest 1.2 s (keyframes every second) and ends near 2.5 s.
    expect(i.durationMs).toBeGreaterThanOrEqual(1300);
    expect(i.durationMs).toBeLessThanOrEqual(2600);
    expect(r.cues).toBeGreaterThanOrEqual(1);
  });

  test("not a WebM file is an error, not garbage output", async () => {
    await expect(fixWebm(bufferSource(rawMp4), sink())).rejects.toThrow();
  });
});

test.describe("MP4 repair", () => {
  test("the raw recording really is broken", async () => {
    const i = await inspectMp4(bufferSource(rawMp4));
    expect(i.durationMs).toBe(0);
    expect(i.hasMehd).toBe(false);
    expect(i.hasMfra).toBe(false);
  });

  test("fixed: real durations, mehd and an mfra index", async () => {
    const out = sink();
    const r = await fixMp4(bufferSource(rawMp4), out);
    const i = await inspectMp4(bufferSource(out.bytes()));
    expect(i.durationMs).toBeGreaterThan(3000);
    expect(i.durationMs).toBeLessThan(3600);
    expect(Math.abs(i.durationMs - r.durationMs)).toBeLessThan(1);
    expect(i.hasMehd).toBe(true);
    expect(i.hasMfra).toBe(true);
    expect(i.tfraEntries).toBeGreaterThanOrEqual(i.fragments); // audio + video entries
    expect(i.tracks.sort()).toEqual(["soun", "vide"]);
  });

  test("fixing twice is stable", async () => {
    const a = sink();
    await fixMp4(bufferSource(rawMp4), a);
    const b = sink();
    await fixMp4(bufferSource(a.bytes()), b);
    expect(await inspectMp4(bufferSource(b.bytes()))).toEqual(await inspectMp4(bufferSource(a.bytes())));
    expect(b.bytes().length).toBe(a.bytes().length);
  });

  test("cut-off tail is dropped cleanly", async () => {
    const cut = rawMp4.subarray(0, Math.floor(rawMp4.length * 0.6));
    const out = sink();
    await fixMp4(bufferSource(cut), out);
    const i = await inspectMp4(bufferSource(out.bytes()));
    expect(i.durationMs).toBeGreaterThan(500);
    expect(i.durationMs).toBeLessThan(3000);
  });

  test("trim keeps whole keyframe fragments within the range", async () => {
    const out = sink();
    await fixMp4(bufferSource(rawMp4), out, { trim: { startMs: 1200, endMs: 2500 } });
    const i = await inspectMp4(bufferSource(out.bytes()));
    expect(i.durationMs).toBeGreaterThan(700);
    expect(i.durationMs).toBeLessThanOrEqual(2600);
    expect(i.fragments).toBeLessThan((await inspectMp4(bufferSource(rawMp4))).fragments);
  });
});
