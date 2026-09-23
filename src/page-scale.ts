import { readSetting, writeSetting } from "./settings";

/**
 * The app draws at its designed size times one chosen scale (设置 → 界面缩放).
 * Pinch and browser zoom stay blocked so a stray gesture never rescales the
 * layout; the zoom keys step the chosen scale instead.
 */
export const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5];
let scale = Number(readSetting("ting.scale", "1"));
if (!SCALES.includes(scale)) scale = 1;

export const pageScale = () => scale;
export function setPageScale(value: number) {
  scale = SCALES.includes(value) ? value : 1;
  writeSetting("ting.scale", String(scale));
  apply();
  window.dispatchEvent(new Event("ting:scale"));
}
function apply() {
  const root = document.documentElement;
  if (scale === 1) root.style.removeProperty("zoom");
  else root.style.setProperty("zoom", String(scale));
}
function step(direction: -1 | 1) {
  const at = SCALES.indexOf(scale);
  const next = SCALES[Math.min(SCALES.length - 1, Math.max(0, at + direction))];
  if (next !== scale) setPageScale(next);
}

export function setupPageScale(allowKeys = true) {
  apply();
  const block = (event: Event) => event.preventDefault();
  // Safari/WKWebView trackpads use GestureEvent; Chromium uses Ctrl+wheel.
  document.addEventListener("gesturestart", block, { passive: false });
  document.addEventListener("gesturechange", block, { passive: false });
  document.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) event.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["+", "=", "-", "0"].includes(event.key)
    ) {
      event.preventDefault();
      if (!allowKeys) return;
      if (event.key === "0") setPageScale(1);
      else step(event.key === "-" ? -1 : 1);
    }
  });
}
