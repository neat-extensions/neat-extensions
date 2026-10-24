// Draw-a-box maths. The user drags a box in CSS pixels of the tab's viewport;
// the captured frame is in device pixels and may be scaled and letterboxed.
// Everything here is pure and unit-tested at DPR 1, 1.5 and 2.

const even = (n) => n - (n % 2);

/** Normalise a drag (any direction) to a box clamped to the viewport, in CSS px. */
export function normaliseDrag(x0, y0, x1, y1, vw, vh) {
  const left = Math.max(0, Math.min(x0, x1));
  const top = Math.max(0, Math.min(y0, y1));
  const right = Math.min(vw, Math.max(x0, x1));
  const bottom = Math.min(vh, Math.max(y0, y1));
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

/** Smallest box worth recording (CSS px). */
export const MIN_BOX = 32;

/**
 * Where the viewport's content sits inside a captured frame. Tab capture keeps
 * the aspect ratio, so a frame with a different shape is letterboxed (bars on
 * two sides). Returns the content rectangle in frame pixels.
 */
export function contentRect(frameW, frameH, vw, vh) {
  const s = Math.min(frameW / vw, frameH / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h, scale: s };
}

/**
 * The crop rectangle in frame pixels for a CSS-px box. Edges are rounded
 * outward (never lose a pixel of what the user selected), then the origin is
 * made even and the size even (4:2:0 video needs it), staying inside the frame.
 */
export function cropRect(box, vw, vh, frameW, frameH) {
  const c = contentRect(frameW, frameH, vw, vh);
  let x0 = Math.floor(c.x + box.x * c.scale + 1e-6);
  let y0 = Math.floor(c.y + box.y * c.scale + 1e-6);
  let x1 = Math.ceil(c.x + (box.x + box.w) * c.scale - 1e-6);
  let y1 = Math.ceil(c.y + (box.y + box.h) * c.scale - 1e-6);
  x0 = Math.max(0, even(x0));
  y0 = Math.max(0, even(y0));
  x1 = Math.min(frameW, x1);
  y1 = Math.min(frameH, y1);
  let w = even(Math.max(2, x1 - x0));
  let h = even(Math.max(2, y1 - y0));
  if (x0 + w > frameW) w = even(frameW - x0);
  if (y0 + h > frameH) h = even(frameH - y0);
  return { x: x0, y: y0, width: w, height: h };
}

/**
 * The capture size to ask Chrome for: the viewport in device pixels, scaled
 * down only if the part we keep (the whole tab, or the box) would be taller
 * than the quality preset allows. Never scaled up. Even numbers.
 */
export function captureSize(vw, vh, dpr, presetHeight, box = null) {
  const keptH = (box ? box.h : vh) * dpr;
  const s = Math.min(1, presetHeight / keptH) * dpr;
  return { width: Math.max(2, even(Math.round(vw * s))), height: Math.max(2, even(Math.round(vh * s))) };
}
