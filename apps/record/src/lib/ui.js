// DOM helpers shared by the popup, the in-page UI and the Pro page. No HTML
// strings anywhere: elements are built with createElement/textContent, icons
// with createElementNS from path data.

const SVG = "http://www.w3.org/2000/svg";

// 24×24, 1.75 stroke, round joins. `fill: true` paths are filled instead.
export const ICONS = {
  tab: ["M3.5 5h17v14h-17z", "M3.5 9.5h17", "M8.5 5v4.5", "M13.5 5v4.5"],
  window: ["M3.5 5h17v14h-17z", "M3.5 8.75h17", "M6.25 6.9h.01", "M8.75 6.9h.01"],
  screen: ["M3 4.5h18v12H3z", "M8.5 20h7", "M12 16.5V20"],
  box: ["M4 8.5V4h4.5", "M15.5 4H20v4.5", "M20 15.5V20h-4.5", "M8.5 20H4v-4.5", "M9.5 12h5", "M12 9.5v5"],
  mic: ["M12 3.25a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3z", "M5.75 11a6.25 6.25 0 0 0 12.5 0", "M12 17.25V20.5"],
  sound: ["M4 9.5h3.5L12 5.75v12.5L7.5 14.5H4z", "M15.5 9.25a4 4 0 0 1 0 5.5", "M18 6.75a7.5 7.5 0 0 1 0 10.5"],
  camera: ["M3.5 7.25h11.25v9.5H3.5z", "M14.75 10.75l5.75-3.25v9l-5.75-3.25"],
  click: ["M9.5 9.5l9.5 3.4-4.1 1.4-1.6 4.2z", "M5 5l1.6 1.6", "M9.5 3v2.25", "M3 9.5h2.25"],
  countdown: ["M12 21a7.75 7.75 0 1 0 0-15.5A7.75 7.75 0 0 0 12 21z", "M12 9.5v3.75l2.5 1.5", "M9.75 2.75h4.5"],
  lock: ["M6.75 10.75h10.5v8.5H6.75z", "M8.75 10.75v-2.5a3.25 3.25 0 0 1 6.5 0v2.5"],
  pause: ["M8.75 5.75v12.5", "M15.25 5.75v12.5"],
  play: ["M8 5.75l10.5 6.25L8 18.25z"],
  stop: [{ d: "M7 7h10v10H7z", fill: true }],
  dot: [{ d: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", fill: true }],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
  link: ["M10 14a4.5 4.5 0 0 0 6.4 0l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4l-1 1", "M14 10a4.5 4.5 0 0 0-6.4 0l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1-1"],
  scissors: ["M6.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6.5 20.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M8.75 8l11 11.5", "M8.75 16l11-11.5"],
  gif: ["M4 5h16v14H4z", "M4 9h16", "M4 15h16", "M9 5v4", "M15 5v4", "M9 15v4", "M15 15v4"],
  folder: ["M3.5 6.25h6l2 2.25h9v10.25h-17z"],
  grip: ["M9.5 7h.01", "M9.5 12h.01", "M9.5 17h.01", "M14.5 7h.01", "M14.5 12h.01", "M14.5 17h.01"],
  infinity: ["M12 12c-2-2.7-3.6-4-5.3-4a4 4 0 0 0 0 8c1.7 0 3.3-1.3 5.3-4zm0 0c2 2.7 3.6 4 5.3 4a4 4 0 0 0 0-8c-1.7 0-3.3 1.3-5.3 4z"],
  three: ["M12 21a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z", "M9.75 9.25h3.5l-2 2.5a2.1 2.1 0 1 1-1.75 3.25"],
  copy: ["M8.5 8.5h11v11h-11z", "M15.5 8.5V4.5h-11v11h4"],
};

export function icon(name, { size = 20, cls = "" } = {}) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (cls) svg.setAttribute("class", cls);
  for (const p of ICONS[name] || []) {
    const path = document.createElementNS(SVG, "path");
    const fill = typeof p === "object" && p.fill;
    path.setAttribute("d", typeof p === "object" ? p.d : p);
    path.setAttribute("fill", fill ? "currentColor" : "none");
    path.setAttribute("stroke", fill ? "none" : "currentColor");
    path.setAttribute("stroke-width", name === "grip" ? "2.6" : "1.75");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

/** h("button", {class: "x", onclick: fn, "aria-label": "…"}, child, "text", …) */
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

export function mb(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
