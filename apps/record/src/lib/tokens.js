// Design tokens — the single source for the popup, the in-page UI and the Pro
// page (the build writes them to tokens.css). White or deep charcoal surfaces,
// one accent, an 8-px grid, soft shadows, the system font stack.
export const TOKENS = `
:host, :root {
  --surface: #ffffff;
  --surface-2: #f6f6f8;
  --surface-3: #ececf0;
  --text: #111114;
  --muted: #62626d;
  --border: rgba(17, 17, 20, 0.09);
  --accent: #d6363c;
  --accent-hover: #c22d33;
  --accent-ink: #ffffff;
  --accent-soft: #fdeceb;
  --focus: #d6363c;
  --shadow: 0 1px 2px rgba(17, 17, 20, 0.06), 0 8px 24px rgba(17, 17, 20, 0.10);
  --shadow-lg: 0 2px 6px rgba(17, 17, 20, 0.08), 0 18px 48px rgba(17, 17, 20, 0.18);
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 16px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :host, :root {
    --surface: #18181b;
    --surface-2: #222226;
    --surface-3: #2d2d32;
    --text: #f3f3f5;
    --muted: #a1a1ab;
    --border: rgba(255, 255, 255, 0.09);
    --accent: #e0444a;
    --accent-hover: #ea5a5f;
    --accent-ink: #ffffff;
    --accent-soft: #3a1d1f;
    --focus: #ff8a8e;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.45);
    --shadow-lg: 0 2px 6px rgba(0, 0, 0, 0.45), 0 18px 48px rgba(0, 0, 0, 0.6);
  }
}
`;
