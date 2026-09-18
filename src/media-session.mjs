// One owner for system metadata. Artwork is serialized and guarded by a track
// generation so a slow response can never put the previous cover on a new song.
export function createMediaSession(audio, options) {
  const { session, metadata, loadArtwork, fallbackArtwork } = options;
  let track = null,
    generation = 0,
    artwork = fallbackArtwork;
  let stopped = false;
  let active = false,
    fetching = false,
    requested = null;
  const safely = (fn) => {
    try {
      fn();
    } catch {
      /* Optional platform API. */
    }
  };
  function publish() {
    if (!session) return;
    safely(() => {
      session.metadata =
        active && track
          ? metadata({
              trackId: String(generation),
              title: track.name,
              artist: track.artist,
              album: track.album,
              artwork: artwork ? [artwork] : [],
            })
          : null;
    });
  }
  function state() {
    if (!session) return;
    safely(() => {
      session.playbackState =
        !active || stopped
          ? "none"
          : audio.paused || audio.ended
            ? "paused"
            : "playing";
    });
    safely(() => session.setVolume?.(audio.muted ? 0 : audio.volume));
    safely(() => {
      const duration = audio.duration;
      if (!active || !Number.isFinite(duration) || duration <= 0) {
        session.setPositionState?.();
        return;
      }
      session.setPositionState?.({
        duration,
        playbackRate:
          Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
            ? audio.playbackRate
            : 1,
        position: Math.max(
          0,
          Math.min(
            duration,
            Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          ),
        ),
      });
    });
  }
  async function fetchArtwork() {
    if (fetching) return;
    fetching = true;
    try {
      while (requested) {
        const request = requested;
        requested = null;
        try {
          const image = await loadArtwork(request.url);
          if (request.generation === generation && active && image) {
            artwork = image;
            publish();
            state();
          }
        } catch {
          /* Keep this track's fallback, never the preceding cover. */
        }
      }
    } finally {
      fetching = false;
    }
  }
  const events = [
    "play",
    "pause",
    "playing",
    "loadedmetadata",
    "durationchange",
    "ratechange",
    "volumechange",
    "seeked",
    "timeupdate",
    "ended",
  ];
  audio.addEventListener("play", () => {
    stopped = false;
  });
  for (const event of events) audio.addEventListener(event, state);
  // WebKit drops supported commands registered before its remote listener
  // exists. Re-publish them when a real media resource becomes ready/active.
  for (const event of ["loadedmetadata", "playing"]) {
    audio.addEventListener(event, () => {
      publish();
      state();
      registerActions();
    });
  }
  audio.addEventListener("error", clear);
  function clear() {
    generation++;
    requested = null;
    active = false;
    stopped = false;
    track = null;
    artwork = fallbackArtwork;
    publish();
    state();
  }
  function select(song) {
    generation++;
    active = true;
    stopped = false;
    track = song;
    artwork = fallbackArtwork;
    requested = song.cover ? { generation, url: song.cover } : null;
    publish();
    state();
    if (session && requested) void fetchArtwork();
  }
  const seek = (value) => {
    if (
      active &&
      Number.isFinite(value) &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0
    )
      audio.currentTime = Math.max(0, Math.min(audio.duration, value));
    state();
  };
  const handlers = {
    play: () => {
      stopped = false;
      options.play();
    },
    pause: options.pause ?? (() => audio.pause()),
    previoustrack: options.previous,
    nexttrack: options.next,
    stop: () => {
      stopped = true;
      (options.pause ?? (() => audio.pause()))();
      seek(0);
    },
    seekby: (details) => seek(audio.currentTime + details.offset),
    volume: (details) => {
      if (Number.isFinite(details.volume)) {
        audio.volume = Math.max(0, Math.min(1, details.volume));
        audio.muted = false;
      }
    },
    seekto: (details) => seek(details.seekTime),
    // Track navigation and interval skipping compete for iOS transport buttons.
    // Music uses previous/next; timeline scrubbing remains available via seekto.
    seekbackward: null,
    seekforward: null,
  };
  function registerActions() {
    for (const [name, handler] of Object.entries(handlers))
      safely(() => session?.setActionHandler(name, handler));
  }
  registerActions();
  return {
    get active() {
      return active;
    },
    select,
    clear,
    refresh: () => {
      publish();
      state();
      registerActions();
    },
  };
}
