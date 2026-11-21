import { $, icon } from "./dom";
import { mobileDevice } from "./platform";
import { readSetting, writeSetting } from "./settings";
import "./stage.css";

/**
 * Playback stage artistry & high-frequency motion:
 * - Album-driven ambient aurora palette extracted off-thread via a 24x24 canvas
 * - Optional Vinyl turntable presentation with articulated tonearm
 * - One-click Theater / Focus mode (F) on desktop
 * - 60/120fps requestAnimationFrame seek progress smoothing
 * - Tactile favorite burst micro-interaction
 */

type Rgb = [number, number, number];

function rgbCss([r, g, b]: Rgb) {
  return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
}

function saturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function luminance(r: number, g: number, b: number) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Sample 3 distinct, vibrant-yet-balanced colors from an already-loaded image. */
function samplePalette(image: HTMLImageElement): [Rgb, Rgb, Rgb] | undefined {
  try {
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return undefined;
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    // Quantize into coarse RGB buckets and score by frequency * chroma.
    const buckets = new Map<
      string,
      { r: number; g: number; b: number; count: number; score: number }
    >();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 180) continue;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const lum = luminance(r, g, b);
      if (lum < 0.08 || lum > 0.94) continue;
      const sat = saturation(r, g, b);
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      const entry = buckets.get(key) || {
        r: 0,
        g: 0,
        b: 0,
        count: 0,
        score: 0,
      };
      entry.r += r;
      entry.g += g;
      entry.b += b;
      entry.count += 1;
      entry.score += 0.35 + sat * 2.2 + (0.5 - Math.abs(lum - 0.5)) * 0.6;
      buckets.set(key, entry);
    }
    if (!buckets.size) return undefined;
    const ranked = [...buckets.values()]
      .map((e) => ({
        rgb: [e.r / e.count, e.g / e.count, e.b / e.count] as Rgb,
        score: e.score,
      }))
      .sort((a, b) => b.score - a.score);
    const chosen: Rgb[] = [ranked[0].rgb];
    const dist = (a: Rgb, b: Rgb) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (const candidate of ranked.slice(1)) {
      if (chosen.every((c) => dist(c, candidate.rgb) > 62)) {
        chosen.push(candidate.rgb);
        if (chosen.length === 3) break;
      }
    }
    while (chosen.length < 3) {
      const base = chosen[chosen.length - 1];
      chosen.push([
        Math.min(245, base[0] * 0.85 + 32),
        Math.min(245, base[1] * 0.92 + 20),
        Math.min(245, base[2] * 1.08 + 18),
      ]);
    }
    return [chosen[0], chosen[1], chosen[2]];
  } catch {
    return undefined;
  }
}

/** Deterministic tasteful fallback hue shift when artwork is unavailable or CORS-opaque. */
function hashHue(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export function ambientEnabled() {
  return readSetting("ting.ambient", "1") !== "0";
}

export function setAmbientEnabled(on: boolean) {
  writeSetting("ting.ambient", on ? "1" : "0");
  document.documentElement.dataset.ambient = on ? "on" : "off";
  window.dispatchEvent(new CustomEvent("ting-ambient-change", { detail: on }));
}

export function setupStage(options: {
  audio: HTMLAudioElement;
  seek: HTMLInputElement;
  isSeeking: () => boolean;
  paintRange: (input: HTMLInputElement) => void;
  ensureLyricsOpen?: () => void;
}) {
  const root = document.documentElement;
  const nowPanel = $(".now-panel");
  const nowCard = $(".now-card");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  // Ambient aura backdrop mounted inside the playback column (z-index: 0).
  const ambient = document.createElement("div");
  ambient.className = "stage-ambient";
  ambient.setAttribute("aria-hidden", "true");
  ambient.innerHTML = `<span class="ambient-orb orb-a"></span><span class="ambient-orb orb-b"></span><span class="ambient-orb orb-c"></span><span class="ambient-grain"></span>`;
  nowPanel.prepend(ambient);

  // Colored bloom halo sitting in the same grid cell behind #now-cover.
  const bloom = document.createElement("div");
  bloom.className = "now-cover-bloom";
  bloom.setAttribute("aria-hidden", "true");
  nowCard.prepend(bloom);

  // Articulated SVG tonearm (only displayed when user activates Vinyl stage mode).
  const arm = document.createElement("div");
  arm.className = "vinyl-arm";
  arm.setAttribute("aria-hidden", "true");
  arm.innerHTML = `<svg viewBox="0 0 80 180" fill="none"><circle cx="56" cy="24" r="14" class="arm-base"/><circle cx="56" cy="24" r="6" class="arm-pivot"/><path d="M56 24 L50 112 L34 152" class="arm-shaft" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="24" y="146" width="14" height="22" rx="3" transform="rotate(24 31 157)" class="arm-head"/></svg>`;
  nowCard.append(arm);

  // Quiet floating stage controls (desktop wide only, hidden on compact/mobile).
  let vinylMode = readSetting("ting.stage.vinyl", "0") === "1" && !mobileDevice;
  let theaterMode = false;
  let vinylButton: HTMLButtonElement | undefined;
  let theaterButton: HTMLButtonElement | undefined;

  if (!mobileDevice) {
    const tools = document.createElement("div");
    tools.className = "stage-tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", "播放舞台视图");
    tools.innerHTML = `<button type="button" id="stage-vinyl-toggle" class="stage-chip" aria-pressed="${vinylMode}" title="切换黑胶唱盘视图">${icon("Disc3")}<span>黑胶</span></button><button type="button" id="stage-theater-toggle" class="stage-chip" aria-pressed="false" title="沉浸剧场模式 (F)">${icon("Maximize2")}<span>剧场</span></button>`;
    nowPanel.append(tools);
    vinylButton = tools.querySelector<HTMLButtonElement>(
      "#stage-vinyl-toggle",
    )!;
    theaterButton = tools.querySelector<HTMLButtonElement>(
      "#stage-theater-toggle",
    )!;
    vinylButton.addEventListener("click", () => setVinyl(!vinylMode));
    theaterButton.addEventListener("click", () => setTheater(!theaterMode));
  }

  function applyVinyl() {
    document.body.classList.toggle("stage-vinyl", vinylMode);
    if (vinylButton) {
      vinylButton.setAttribute("aria-pressed", String(vinylMode));
      vinylButton.title = vinylMode ? "切回纯净封面" : "切换黑胶唱盘视图";
    }
  }
  function setVinyl(on: boolean) {
    if (mobileDevice) return;
    vinylMode = on;
    writeSetting("ting.stage.vinyl", on ? "1" : "0");
    applyVinyl();
  }
  function applyTheater() {
    document.body.classList.toggle("stage-theater", theaterMode);
    if (theaterButton) {
      theaterButton.setAttribute("aria-pressed", String(theaterMode));
      theaterButton.innerHTML = `${icon(theaterMode ? "Minimize2" : "Maximize2")}<span>${theaterMode ? "退出" : "剧场"}</span>`;
      theaterButton.title = theaterMode
        ? "退出沉浸剧场模式 (Esc / F)"
        : "沉浸剧场模式 (F)";
    }
  }
  function setTheater(on: boolean) {
    if (mobileDevice) return;
    // Theater mode shines on wide windows; refuse below desktop two-column width.
    if (on && window.innerWidth < 900) return;
    theaterMode = on;
    applyTheater();
    if (on) options.ensureLyricsOpen?.();
  }
  window.addEventListener("resize", () => {
    if (theaterMode && window.innerWidth < 900) setTheater(false);
  });

  // Sync ambient enabled state.
  root.dataset.ambient = ambientEnabled() ? "on" : "off";
  applyVinyl();
  applyTheater();

  // Palette extraction with serial guard so stale covers never overwrite new ones.
  let paletteSerial = 0;
  let lastSeed = "";
  function setPalette(colors: [Rgb, Rgb, Rgb] | undefined) {
    if (!colors) {
      root.style.removeProperty("--ambient-1");
      root.style.removeProperty("--ambient-2");
      root.style.removeProperty("--ambient-3");
      root.dataset.ambientCustom = "0";
      return;
    }
    root.style.setProperty("--ambient-1", rgbCss(colors[0]));
    root.style.setProperty("--ambient-2", rgbCss(colors[1]));
    root.style.setProperty("--ambient-3", rgbCss(colors[2]));
    root.dataset.ambientCustom = "1";
  }

  function applyFallbackPalette(seed: string) {
    if (!seed) {
      setPalette(undefined);
      return;
    }
    const h = hashHue(seed);
    setPalette([
      hslToRgb(h, 0.56, 0.56),
      hslToRgb((h + 44) % 360, 0.48, 0.52),
      hslToRgb((h + 312) % 360, 0.42, 0.6),
    ]);
  }

  function updateCover(src: string, seed = "") {
    const key = src || seed;
    if (key === lastSeed) return;
    lastSeed = key;
    const serial = ++paletteSerial;
    if (!src) {
      applyFallbackPalette(seed);
      return;
    }
    // Immediate soft placeholder tone derived from track while image samples.
    applyFallbackPalette(seed || src);
    // Probe with anonymous CORS so canvas readback works when the CDN allows it.
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.referrerPolicy = "no-referrer";
    probe.decoding = "async";
    probe.onload = () => {
      if (serial !== paletteSerial) return;
      const colors = samplePalette(probe);
      if (colors) setPalette(colors);
    };
    probe.onerror = () => {
      // Keep the deterministic harmonic fallback palette quietly.
    };
    probe.src = src;
  }

  // Smooth 60/120fps seek-bar progress while playing (replaces 4Hz timeupdate stepping).
  let rafId = 0;
  function tickProgress() {
    rafId = 0;
    const { audio, seek, isSeeking, paintRange } = options;
    if (
      audio.paused ||
      audio.ended ||
      document.hidden ||
      reduced.matches ||
      !Number.isFinite(audio.duration) ||
      audio.duration <= 0
    )
      return;
    if (!isSeeking()) {
      const pct = Math.min(
        100,
        Math.max(0, (audio.currentTime / audio.duration) * 100),
      );
      seek.style.setProperty("--fill", `${pct}%`);
      // Keep slider value aligned without thrashing layout.
      seek.value = String(audio.currentTime);
    }
    rafId = requestAnimationFrame(tickProgress);
  }
  function syncProgressLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (
      !options.audio.paused &&
      !options.audio.ended &&
      !document.hidden &&
      !reduced.matches
    )
      rafId = requestAnimationFrame(tickProgress);
  }
  for (const event of ["play", "playing", "pause", "ended", "emptied"])
    options.audio.addEventListener(event, syncProgressLoop);
  document.addEventListener("visibilitychange", syncProgressLoop);
  reduced.addEventListener("change", syncProgressLoop);

  /** Tactile micro-burst when favoriting a track. */
  function burstHeart(target: HTMLElement | null) {
    if (!target || reduced.matches || typeof target.animate !== "function")
      return;
    target.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.26)", offset: 0.35 },
        { transform: "scale(0.92)", offset: 0.7 },
        { transform: "scale(1)" },
      ],
      { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }

  return {
    updateCover,
    burstHeart,
    isTheater: () => theaterMode,
    setTheater,
    toggleTheater: () => setTheater(!theaterMode),
    setVinyl,
  };
}
