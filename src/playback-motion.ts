import "./playback-motion.css";
import { MOTION } from "./motion";
import type { PlaybackState } from "./playback-state";

// Mirrors --now-pulse-period in playback-motion.css. One slow breath is the
// only continuous effect in the app; everything else is finite.
const PULSE_PERIOD = 4400;

const preference = matchMedia("(prefers-reduced-motion: reduce)");
let pulse: Animation | undefined;
let settle: Animation | undefined;
let state: PlaybackState = "idle";
let amp = 0;
let observer: ResizeObserver | undefined;
let observed: HTMLElement | undefined;

const cover = () => document.querySelector<HTMLElement>("#now-cover");

/** The travel belongs to the layout, so the stylesheet owns the amplitude. */
function amplitude(element: HTMLElement) {
  const value = parseFloat(
    getComputedStyle(element).getPropertyValue("--now-pulse"),
  );
  return Number.isFinite(value) && value > 1 ? value : 1.022;
}

function start(element: HTMLElement): Animation | undefined {
  if (
    pulse ||
    preference.matches ||
    element.clientWidth === 0 ||
    typeof element.animate !== "function"
  )
    return pulse;
  settle?.cancel();
  settle = undefined;
  amp = amplitude(element);
  // The container is the target, not the image inside it: cover.ts replaces
  // that child on every track, and the framed shadow should breathe too.
  // The curve belongs to each half, not to the cycle: easing the whole
  // iteration would run fastest exactly at the peak and kink at the turn.
  pulse = element.animate(
    [
      { transform: "scale(1)", easing: MOTION.breath },
      { transform: `scale(${amp})`, offset: 0.5, easing: MOTION.breath },
      { transform: "scale(1)" },
    ],
    { duration: PULSE_PERIOD, iterations: Infinity, easing: "linear" },
  );
  if (document.hidden) pulse.pause();
  return pulse;
}

/** Stopping is a settle, never a cut: the resting state is always identity. */
function stopPulse(element: HTMLElement) {
  if (!pulse) return;
  // Read the painted frame before cancelling; afterwards it is already gone.
  const from = getComputedStyle(element).transform;
  pulse.cancel();
  pulse = undefined;
  if (preference.matches || from === "none") return;
  settle?.cancel();
  const animation = element.animate(
    [{ transform: from }, { transform: "none" }],
    { duration: MOTION.t5, easing: MOTION.enter },
  );
  settle = animation;
  animation.onfinish = () => {
    animation.cancel();
    if (settle === animation) settle = undefined;
  };
}

function watch(element: HTMLElement) {
  if (observed === element || typeof ResizeObserver !== "function") return;
  observer ||= new ResizeObserver(() => resize());
  if (observed) observer.unobserve(observed);
  observer.observe(element);
  observed = element;
}

// A transform never triggers this; only a real layout change does, such as the
// compact row becoming a full-width column or a landscape phone hiding the art.
function resize() {
  const element = cover();
  if (!element) return;
  if (!pulse) {
    sync();
    return;
  }
  if (element.clientWidth === 0) {
    stopPulse(element);
    return;
  }
  if (amplitude(element) === amp) return;
  // Keep the phase across the swap: the breath must not restart mid-window.
  const time = pulse.currentTime;
  pulse.cancel();
  pulse = undefined;
  const restarted = start(element);
  if (restarted) restarted.currentTime = time;
}

function sync() {
  const element = cover();
  if (!element) return;
  watch(element);
  if (state === "playing" && !preference.matches) start(element);
  else stopPulse(element);
}

export function applyPlaybackMotion(next: PlaybackState): void {
  state = next;
  sync();
}

// A window that is merely behind another one keeps breathing; only a hidden
// document stops, and it resumes from the same phase rather than jumping.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pulse?.pause();
  else pulse?.play();
});
preference.addEventListener("change", sync);
