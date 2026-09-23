import { readSetting, writeSetting } from "./settings";

/**
 * Everything between the song and the speakers: the listener's own volume,
 * loudness normalisation (a per-track gain), fades for crossfading and the
 * sleep timer, and — on desktop — a five-band equaliser. The slider always
 * shows the listener's volume; the element's volume is that times the rest.
 */
export const EQ_BANDS = [60, 230, 910, 3600, 14000];
export const EQ_PRESETS: Record<string, { label: string; gains: number[] }> = {
  flat: { label: "关闭", gains: [0, 0, 0, 0, 0] },
  bass: { label: "低音增强", gains: [6, 3, 0, 0, 1] },
  vocal: { label: "人声", gains: [-2, -1, 3, 4, 1] },
  treble: { label: "高音增强", gains: [0, 0, 0, 3, 6] },
  warm: { label: "温暖", gains: [3, 2, 0, -1, -3] },
  night: { label: "夜间", gains: [-3, -1, 1, 0, -4] },
};
/** Typical track loudness: gains are relative to this so most songs sit near 1. */
const REFERENCE_GAIN = -7;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const setting = (key: string, fallback: string) => readSetting(key, fallback);

export function setupSound(audio: HTMLAudioElement, desktop: boolean) {
  let user = clamp(Number(setting("ting.volume", "0.7")) || 0.7);
  let normalize = setting("ting.normalize", "0") === "1";
  const known = (name: string) => Object.hasOwn(EQ_PRESETS, name);
  let preset = setting("ting.eq", "flat");
  if (!known(preset) || !desktop) preset = "flat";
  let crossfade = clamp(Number(setting("ting.crossfade", "0")) || 0, 0, 12);
  // Song-change fades and the sleep timer's fade are separate factors, so a
  // song ending mid-way through the sleep fade cannot cancel it.
  let trackGain = 1,
    fade = 1,
    sleep = 1;
  let context: AudioContext | undefined;
  let filters: BiquadFilterNode[] = [];
  const routed = new WeakSet<HTMLMediaElement>();

  function apply() {
    const next = clamp(user * trackGain * fade * sleep);
    if (Math.abs(audio.volume - next) > 0.0005) audio.volume = next;
  }
  /** Platform or ReplayGain loudness in dB; unknown songs count as typical. */
  function setTrackGain(db: number | undefined) {
    trackGain = normalize
      ? clamp(10 ** (((db ?? REFERENCE_GAIN) - REFERENCE_GAIN) / 20), 0.1, 1)
      : 1;
    apply();
  }

  // Fades: one running ramp at a time, on a timer so it also runs while the
  // window is hidden (animation frames pause there).
  let ramp = 0;
  function rampFade(to: number, seconds: number, done?: () => void) {
    clearInterval(ramp);
    const from = fade,
      start = performance.now(),
      span = Math.max(0.05, seconds) * 1000;
    ramp = window.setInterval(() => {
      const t = clamp((performance.now() - start) / span);
      fade = from + (to - from) * t;
      apply();
      if (t >= 1) {
        clearInterval(ramp);
        done?.();
      }
    }, 40);
  }
  function resetFade() {
    clearInterval(ramp);
    fade = 1;
    apply();
  }
  let sleepRamp = 0;
  function sleepOut(seconds: number, done: () => void) {
    clearInterval(sleepRamp);
    const start = performance.now(),
      span = seconds * 1000;
    sleepRamp = window.setInterval(() => {
      const t = clamp((performance.now() - start) / span);
      sleep = 1 - t;
      apply();
      if (t >= 1) {
        clearInterval(sleepRamp);
        done();
        sleep = 1;
        apply();
      }
    }, 40);
  }

  // The equaliser is only ever built on request: once an element feeds an
  // AudioContext it cannot leave it, and phones pause such contexts in the
  // background.
  function ensureGraph() {
    if (context) return context;
    context = new AudioContext();
    filters = EQ_BANDS.map((frequency, i) => {
      const f = context!.createBiquadFilter();
      f.type =
        i === 0
          ? "lowshelf"
          : i === EQ_BANDS.length - 1
            ? "highshelf"
            : "peaking";
      f.frequency.value = frequency;
      f.Q.value = 1;
      return f;
    });
    filters.reduce((a, b) => (a.connect(b), b));
    filters[filters.length - 1].connect(context.destination);
    return context;
  }
  function route(element: HTMLMediaElement) {
    if (routed.has(element)) return;
    const ctx = ensureGraph();
    element.crossOrigin = "anonymous";
    ctx.createMediaElementSource(element).connect(filters[0]);
    routed.add(element);
  }
  function applyPreset() {
    const gains = EQ_PRESETS[preset].gains;
    filters.forEach((f, i) => (f.gain.value = gains[i]));
  }
  /** Whether the element must reload its source to pass through the equaliser. */
  const needsRoute = () => desktop && preset !== "flat" && !routed.has(audio);
  if (needsRoute()) {
    // Before the first load, so the first song already arrives CORS-clean.
    audio.crossOrigin = "anonymous";
  }
  document.addEventListener("pointerdown", () => void context?.resume(), {
    passive: true,
  });

  // Crossfade tail: the last seconds of the outgoing song, fading out while
  // the next one fades in on the main element.
  const tail = new Audio();
  tail.preload = "auto";
  let tailTimer = 0;
  function playTail(src: string, time: number) {
    stopTail();
    if (context && routed.has(audio)) route(tail);
    tail.src = src;
    tail.currentTime = time;
    tail.volume = audio.volume;
    tail.muted = audio.muted;
    void tail.play().catch(() => {});
    const start = performance.now(),
      from = tail.volume,
      span = crossfade * 1000;
    tailTimer = window.setInterval(() => {
      const t = clamp((performance.now() - start) / span);
      tail.volume = from * (1 - t);
      if (t >= 1) stopTail();
    }, 40);
  }
  /** Silences the outgoing song at once (pause, another pick, mute). */
  function stopTail() {
    clearInterval(tailTimer);
    if (!tail.getAttribute("src")) return;
    tail.pause();
    tail.removeAttribute("src");
    tail.load();
  }

  return {
    get volume() {
      return user;
    },
    setVolume(v: number) {
      user = clamp(v);
      writeSetting("ting.volume", String(user));
      apply();
    },
    get normalize() {
      return normalize;
    },
    setNormalize(on: boolean, db?: number) {
      normalize = on;
      writeSetting("ting.normalize", on ? "1" : "0");
      setTrackGain(db);
    },
    setTrackGain,
    get preset() {
      return preset;
    },
    /** Returns true when the current song must reload to be equalised. */
    setPreset(name: string): boolean {
      if (!desktop || !known(name)) return false;
      preset = name;
      writeSetting("ting.eq", name);
      if (name === "flat") {
        if (filters.length) applyPreset();
        return false;
      }
      const reload = !routed.has(audio);
      route(audio);
      applyPreset();
      void context?.resume();
      return reload;
    },
    /** Called before each load: route when an equaliser preset is on. */
    prepare() {
      if (needsRoute()) {
        route(audio);
        applyPreset();
      }
    },
    get crossfade() {
      return crossfade;
    },
    setCrossfade(seconds: number) {
      crossfade = clamp(Math.round(seconds), 0, 12);
      writeSetting("ting.crossfade", String(crossfade));
    },
    playTail,
    stopTail,
    fadeIn(seconds: number) {
      fade = 0;
      apply();
      rampFade(1, seconds);
    },
    /** The sleep timer's slow fade; restores full level after `done`. */
    sleepOut,
    resetFade,
  };
}
export type Sound = ReturnType<typeof setupSound>;
