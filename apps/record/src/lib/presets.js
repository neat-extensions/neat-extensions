// Quality presets, in plain words. Sizes are what we measured on a busy page over
// 60-second recordings (tests/e2e-record/measure.spec.js → test-results/record-measure.json):
// Good 10.4, Better 20.3, Best (1440p) 39.2 MB a minute; a 31-minute 1080p recording
// came to 20.0. Quiet screens come out smaller.
export const PRESETS = [
  { id: "good", label: "Good", detail: "720p", height: 720, videoBps: 1_200_000, mbPerMin: 10, pro: false },
  { id: "better", label: "Better", detail: "1080p HD", height: 1080, videoBps: 2_500_000, mbPerMin: 20, pro: false },
  { id: "best", label: "Best", detail: "1440p / 4K", height: 2160, videoBps: 5_000_000, mbPerMin: 40, pro: true },
];
export const DEFAULT_PRESET = "better";
export const AUDIO_BPS = 128_000;

export function presetById(id, { pro = false } = {}) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS.find((x) => x.id === DEFAULT_PRESET);
  return p.pro && !pro ? PRESETS.find((x) => x.id === DEFAULT_PRESET) : p;
}

/** "~20 MB a minute" */
export function sizeLabel(p) {
  return `~${p.mbPerMin} MB a minute`;
}

/**
 * Best keeps 4K only where it is real: the bitrate scales with the pixel count
 * actually captured, so a 1440p screen does not get a 4K bitrate.
 */
export function videoBitrate(p, width, height) {
  if (p.id !== "best") return p.videoBps;
  const px = Math.max(1, width * height);
  return Math.round(Math.min(12_000_000, Math.max(p.videoBps, (p.videoBps * px) / (2560 * 1440))));
}
