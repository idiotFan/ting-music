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
  for (const event of ["waiting", "stalled"])
    audio.addEventListener(event, () => {
      live = false;
      scheduleWait();
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
  return { refresh: apply, state: () => current };
}
