import "./playback-motion.css";

/** What the audio element is actually doing, never what a button intends. */
export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

/**
 * Publish the real transport state on `body[data-playback]`. The transport
 * button stays optimistic on purpose; this reads only the media events, so a
 * cover can never claim to be playing while the stream is still buffering.
 */
export function setupPlaybackState(
  audio: HTMLAudioElement,
  hasTrack: () => boolean,
  isPreparing: () => boolean,
): { refresh(): void; state(): PlaybackState } {
  let live = false,
    waiting = false,
    failed = false,
    waitTimer = 0,
    current: PlaybackState = "idle";
  function clearWait() {
    clearTimeout(waitTimer);
    waitTimer = 0;
  }
  // A stall shorter than a blink is not a state worth showing: dragging the
  // seek bar and ordinary network jitter would otherwise flicker the badge.
  function scheduleWait() {
    if (waitTimer) return;
    waitTimer = window.setTimeout(() => {
      waitTimer = 0;
      waiting = true;
      apply();
    }, 180);
  }
  function derive(): PlaybackState {
    if (!hasTrack()) return "idle";
    if (failed) return "error";
    if (live) return "playing";
    // play() has been called but `playing` has not arrived: still loading.
    if (waiting || isPreparing() || (!audio.paused && !audio.ended))
      return "loading";
    return "paused";
  }
  function apply() {
    const next = derive();
    if (next === current) return;
    current = next;
    document.body.dataset.playback = next;
  }
  audio.addEventListener("playing", () => {
    live = true;
    waiting = false;
    failed = false;
    clearWait();
    apply();
  });
  audio.addEventListener("pause", () => {
    live = false;
    waiting = false;
    clearWait();
    apply();
  });
  audio.addEventListener("waiting", () => {
    live = false;
    scheduleWait();
  });
  // `stalled` only says the network went quiet; buffered audio keeps playing
  // through it (window resizes on macOS trigger it routinely). Treat it as a
  // stall only when the element really has nothing left to play.
  audio.addEventListener("stalled", () => {
    if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
    live = false;
    scheduleWait();
  });
  // Progress is the ground truth: a track that keeps advancing is playing,
  // whatever the last network event said.
  audio.addEventListener("timeupdate", () => {
    if (
      !live &&
      !audio.paused &&
      !audio.ended &&
      !audio.seeking &&
      audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    ) {
      live = true;
      waiting = false;
      clearWait();
      apply();
    }
  });
  audio.addEventListener("ended", () => {
    live = false;
    waiting = false;
    clearWait();
    apply();
  });
  audio.addEventListener("error", () => {
    live = false;
    waiting = false;
    clearWait();
    // Tearing a source down raises the same event; only a real source failed.
    if (audio.getAttribute("src")) failed = true;
    apply();
  });
  for (const event of ["emptied", "loadstart"])
    audio.addEventListener(event, () => {
      failed = false;
      live = false;
      waiting = false;
      clearWait();
      apply();
    });
  // Publish the resting state without deriving it: the callers this closes
  // over are declared later in the module and must not be read yet.
  document.body.dataset.playback = current;
  // Hidden windows freeze the decorative animations (see playback-motion.css).
  const hidden = () =>
    document.documentElement.classList.toggle("app-hidden", document.hidden);
  document.addEventListener("visibilitychange", hidden);
  hidden();
  return { refresh: apply, state: () => current };
}
