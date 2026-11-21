import { $, icon } from "./dom";
import { MOTION, animateContent } from "./motion";
import { mobileDevice } from "./platform";
import { readSetting, writeSetting } from "./settings";
import "./stage.css";

/**
 * Playback stage controller:
 * - Album-driven ambient aurora palette extracted via an offscreen 24x24 canvas
 * - Optional Vinyl turntable mode with realistic spin-up / coast-down inertia
 *   (never snaps back to 0deg on pause) and brushed-metal tonearm
 * - Choreographed Theater / Focus mode (F) on wide desktop viewports
 * - Unified single-loop rAF clock driving 60/120fps seek smoothing, vinyl
 *   inertia, and subtle ambient drift only when visible & active
 * - Tactile favorite heart micro-burst
 */

type Rgb = [number, number, number];

const MAX_VINYL_DPS = 18; // ~33 RPM visual feel (calm, hypnotic, never dizzying)
const VINYL_ACCEL = 32; // deg/s^2 spin-up torque
const VINYL_BRAKE = 26; // deg/s^2 natural platter coast-down friction

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

/** Sample 3 distinct, balanced colors from an already-loaded image. */
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

export function setupStage(options: {
  audio: HTMLAudioElement;
  seek: HTMLInputElement;
  isSeeking: () => boolean;
  ensureLyricsOpen?: () => void;
}) {
  const root = document.documentElement;
  const nowPanel = $(".now-panel");
  const nowCard = $(".now-card");
  const nowCover = $("#now-cover");
  const player = $(".player");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  // Ambient aura backdrop mounted inside the playback column (z-index: 0).
  const ambient = document.createElement("div");
  ambient.className = "stage-ambient";
  ambient.setAttribute("aria-hidden", "true");
  ambient.innerHTML = `<span class="ambient-orb orb-a"></span><span class="ambient-orb orb-b"></span><span class="ambient-orb orb-c"></span><span class="ambient-grain"></span>`;
  nowPanel.prepend(ambient);
  const orbA = ambient.querySelector<HTMLElement>(".orb-a")!;
  const orbB = ambient.querySelector<HTMLElement>(".orb-b")!;
  const orbC = ambient.querySelector<HTMLElement>(".orb-c")!;

  // Colored bloom halo sitting in the same grid cell behind #now-cover.
  const bloom = document.createElement("div");
  bloom.className = "now-cover-bloom";
  bloom.setAttribute("aria-hidden", "true");
  nowCard.prepend(bloom);

  // Sculptural recessed well + Dieter Rams signal LED around the play/pause dial.
  const toggleButton = $("#toggle");
  if (
    toggleButton &&
    !toggleButton.parentElement?.classList.contains("play-dial-wrap")
  ) {
    const wrap = document.createElement("span");
    wrap.className = "play-dial-wrap";
    wrap.innerHTML = `<i class="play-dial-led" aria-hidden="true"></i>`;
    toggleButton.parentElement?.insertBefore(wrap, toggleButton);
    wrap.append(toggleButton);
  }

  // Articulated brushed-aluminum Hi-Fi tonearm (displayed in Vinyl stage mode).
  const arm = document.createElement("div");
  arm.className = "vinyl-arm";
  arm.setAttribute("aria-hidden", "true");
  arm.innerHTML = `<svg viewBox="0 0 110 230" fill="none">
    <defs>
      <linearGradient id="arm-metal" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#f2f3f0"/>
        <stop offset="45%" stop-color="#b8bcb9"/>
        <stop offset="100%" stop-color="#767b78"/>
      </linearGradient>
      <radialGradient id="arm-gimbal" cx="38%" cy="32%" r="65%">
        <stop offset="0%" stop-color="#f7f7f5"/>
        <stop offset="60%" stop-color="#c4c7c4"/>
        <stop offset="100%" stop-color="#7b807d"/>
      </radialGradient>
      <linearGradient id="arm-shell" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#e5e7e4"/>
        <stop offset="55%" stop-color="#a2a6a3"/>
        <stop offset="100%" stop-color="#5d6260"/>
      </linearGradient>
    </defs>
    <circle cx="76" cy="36" r="22" class="arm-well"/>
    <circle cx="76" cy="36" r="16" fill="url(#arm-gimbal)" stroke="rgba(0,0,0,0.22)" stroke-width="1"/>
    <rect x="69" y="6" width="14" height="16" rx="3" fill="url(#arm-metal)" stroke="rgba(0,0,0,0.2)" stroke-width="0.8"/>
    <circle cx="76" cy="36" r="5.5" class="arm-pivot"/>
    <path d="M76 42 L68 148 L48 188" stroke="url(#arm-metal)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M75 42 L67 148 L47 187" stroke="rgba(255,255,255,0.65)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <g transform="translate(46 184) rotate(26)">
      <rect x="-9" y="-2" width="18" height="28" rx="3.5" fill="url(#arm-shell)" stroke="rgba(0,0,0,0.28)" stroke-width="1"/>
      <circle cx="-3.5" cy="7" r="1.4" fill="#3a3d3b"/>
      <circle cx="3.5" cy="7" r="1.4" fill="#3a3d3b"/>
      <rect x="-4" y="18" width="8" height="9" rx="1.5" fill="#222524"/>
      <path d="M4 21 L12 24" stroke="#d94f30" stroke-width="1.6" stroke-linecap="round"/>
    </g>
  </svg>`;
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

  // Vinyl platter & unified rAF loop state (declared before initial applyVinyl/syncLoop).
  let vinylAngle = 0;
  let vinylVelocity = 0;
  let ambientPhase = 0;
  let lastPct = -1;
  let rafId = 0;
  let lastFrame = 0;

  function applyVinylRotation() {
    const disc = nowCover.firstElementChild as HTMLElement | null;
    if (!disc) return;
    if (vinylMode && vinylAngle !== 0) {
      disc.style.transform = `rotate(${vinylAngle.toFixed(2)}deg)`;
    } else if (!vinylMode && disc.style.transform) {
      disc.style.removeProperty("transform");
    }
  }

  function clearVinylRotation() {
    vinylVelocity = 0;
    nowCover
      .querySelectorAll<HTMLElement>("img, .fallback-cover")
      .forEach((n) => {
        n.style.removeProperty("transform");
      });
  }

  function applyVinyl(animate = false) {
    document.body.classList.toggle("stage-vinyl", vinylMode);
    if (!vinylMode) clearVinylRotation();
    else applyVinylRotation();
    if (vinylButton) {
      vinylButton.setAttribute("aria-pressed", String(vinylMode));
      vinylButton.title = vinylMode ? "切回纯净封面" : "切换黑胶唱盘视图";
    }
    if (animate && !reduced.matches) {
      animateContent(nowCover, {
        distance: 0,
        scaleFrom: 0.94,
        duration: MOTION.t3,
        from: 0.65,
        easing: MOTION.enter,
      });
      if (vinylMode) {
        animateContent(arm, {
          axis: "x",
          direction: 1,
          distance: 14,
          duration: MOTION.t4,
          from: 0,
          easing: MOTION.enter,
        });
      }
    }
    syncLoop();
  }

  function setVinyl(on: boolean) {
    if (mobileDevice || on === vinylMode) return;
    vinylMode = on;
    writeSetting("ting.stage.vinyl", on ? "1" : "0");
    applyVinyl(true);
  }

  function applyTheater(animate = false) {
    document.body.classList.toggle("stage-theater", theaterMode);
    if (theaterButton) {
      theaterButton.setAttribute("aria-pressed", String(theaterMode));
      theaterButton.innerHTML = `${icon(theaterMode ? "Minimize2" : "Maximize2")}<span>${theaterMode ? "退出" : "剧场"}</span>`;
      theaterButton.title = theaterMode
        ? "退出沉浸剧场模式 (Esc / F)"
        : "沉浸剧场模式 (F)";
    }
    if (animate && !reduced.matches) {
      animateContent(nowCard, {
        distance: 0,
        scaleFrom: theaterMode ? 0.96 : 1.03,
        duration: MOTION.t4,
        from: 0.72,
        easing: MOTION.move,
      });
      animateContent(player, {
        axis: "y",
        direction: 1,
        distance: 8,
        duration: MOTION.t3,
        from: 0.7,
        easing: MOTION.enter,
      });
      if (!theaterMode) {
        animateContent($(".library"), {
          axis: "x",
          direction: -1,
          distance: 14,
          duration: MOTION.t3,
          from: 0,
          easing: MOTION.enter,
        });
      }
    }
  }

  function setTheater(on: boolean) {
    if (mobileDevice || on === theaterMode) return;
    if (on && window.innerWidth < 900) return;
    theaterMode = on;
    applyTheater(true);
    if (on) options.ensureLyricsOpen?.();
  }

  window.addEventListener("resize", () => {
    if (theaterMode && window.innerWidth < 900) setTheater(false);
  });

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
    applyFallbackPalette(seed || src);
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.referrerPolicy = "no-referrer";
    probe.decoding = "async";
    probe.onload = () => {
      if (serial !== paletteSerial) return;
      const colors = samplePalette(probe);
      if (colors) setPalette(colors);
    };
    probe.onerror = () => {};
    probe.src = src;
  }

  // Unified single-loop rAF stage clock:
  // 1) Pixel-throttled seek progress smoothing while playing
  // 2) Realistic vinyl platter spin-up & coast-down inertia (holds exact angle on pause)
  // 3) Subtle ambient orb drift while playing on wide desktop (freezes cleanly on pause)
  const isPlaying = () =>
    !options.audio.paused &&
    !options.audio.ended &&
    options.audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

  function needsLoop() {
    if (document.hidden || reduced.matches) return false;
    if (isPlaying()) return true;
    // Keep coasting vinyl platter smoothly down to 0 deg/s after pause.
    if (vinylMode && vinylVelocity > 0.05) return true;
    return false;
  }

  function tick(now: number) {
    rafId = 0;
    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
    lastFrame = now;
    const playing = isPlaying();

    // 1) Smooth seek bar progress (throttled to visually meaningful delta).
    const { audio, seek, isSeeking } = options;
    if (
      playing &&
      !isSeeking() &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0
    ) {
      const pct = Math.min(
        100,
        Math.max(0, (audio.currentTime / audio.duration) * 100),
      );
      if (Math.abs(pct - lastPct) >= 0.08) {
        lastPct = pct;
        seek.style.setProperty("--fill", `${pct.toFixed(2)}%`);
        seek.value = String(audio.currentTime);
      }
    }

    // 2) Vinyl platter inertia physics (only when Vinyl mode is active).
    if (vinylMode) {
      const target = playing ? MAX_VINYL_DPS : 0;
      if (vinylVelocity < target) {
        vinylVelocity = Math.min(target, vinylVelocity + VINYL_ACCEL * dt);
      } else if (vinylVelocity > target) {
        vinylVelocity = Math.max(target, vinylVelocity - VINYL_BRAKE * dt);
      }
      if (vinylVelocity > 0.01) {
        vinylAngle = (vinylAngle + vinylVelocity * dt) % 360;
        applyVinylRotation();
      }
    }

    // 3) Gentle ambient orb drift on wide desktop while playing (never teleports on pause).
    if (
      playing &&
      !mobileDevice &&
      window.innerWidth >= 900 &&
      root.dataset.ambient === "on"
    ) {
      ambientPhase += dt * 0.22;
      const ax = Math.sin(ambientPhase) * 24;
      const ay = Math.cos(ambientPhase * 0.78) * 18;
      const bx = Math.cos(ambientPhase * 0.65) * -26;
      const by = Math.sin(ambientPhase * 0.84) * -20;
      const cx = Math.sin(ambientPhase * 0.92 + 1.4) * 18;
      const cy = Math.cos(ambientPhase * 0.7 + 0.8) * 16;
      orbA.style.transform = `translate3d(${ax.toFixed(1)}px, ${ay.toFixed(1)}px, 0)`;
      orbB.style.transform = `translate3d(${bx.toFixed(1)}px, ${by.toFixed(1)}px, 0)`;
      orbC.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;
    }

    if (needsLoop()) rafId = requestAnimationFrame(tick);
    else lastFrame = 0;
  }

  function syncLoop() {
    if (needsLoop()) {
      if (!rafId) {
        lastFrame = 0;
        rafId = requestAnimationFrame(tick);
      }
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      lastFrame = 0;
    }
  }

  for (const event of [
    "play",
    "playing",
    "pause",
    "ended",
    "emptied",
    "seeked",
  ])
    options.audio.addEventListener(event, () => {
      if (event === "seeked" || event === "emptied") lastPct = -1;
      syncLoop();
    });
  document.addEventListener("visibilitychange", syncLoop);
  reduced.addEventListener("change", () => {
    if (reduced.matches) clearVinylRotation();
    syncLoop();
  });

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

  // Apply initial state once every helper and listener is ready.
  root.dataset.ambient =
    readSetting("ting.ambient", "1") !== "0" ? "on" : "off";
  applyVinyl(false);
  applyTheater(false);

  return {
    updateCover,
    burstHeart,
    isTheater: () => theaterMode,
    setTheater,
    toggleTheater: () => setTheater(!theaterMode),
    setVinyl,
  };
}
