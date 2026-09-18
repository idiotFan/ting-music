// Coalesced, ordered IPC: a slow native update can never restore an older song.
// Only artwork changes cross IPC as PNG; progress ticks carry small deltas.
export function createNativeSession({
  update,
  onError = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let metadata = null,
    playbackState = "none",
    position,
    volume = 0.7;
  let metadataVersion = 0,
    sentVersion = -1,
    sequence = 0;
  let dirty = false,
    running = false,
    timer,
    disposed = false;
  const actions = new Map();
  function enqueue(immediate = false) {
    if (disposed) return;
    dirty = true;
    if (immediate && timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    if (running || timer !== undefined) return;
    timer = schedule(
      () => {
        timer = undefined;
        void flush();
      },
      immediate ? 0 : 750,
    );
  }
  async function flush() {
    if (disposed || running || !dirty) return;
    running = true;
    dirty = false;
    const version = metadataVersion;
    const snapshot = {
      sequence: ++sequence,
      playbackState,
      position: position ?? null,
      volume,
    };
    if (version !== sentVersion) snapshot.metadata = metadata;
    try {
      await update(snapshot);
      sentVersion = version;
    } catch {
      onError();
    } finally {
      running = false;
      // Only replay the latest state; no growing queue of progress updates.
      if (dirty) enqueue(true);
    }
  }
  return {
    get metadata() {
      return metadata;
    },
    set metadata(value) {
      metadata = value;
      metadataVersion++;
      enqueue(true);
    },
    get playbackState() {
      return playbackState;
    },
    set playbackState(value) {
      if (playbackState !== value) {
        playbackState = value;
        enqueue(true);
      }
    },
    setPositionState(value) {
      position = value;
      enqueue();
    },
    setVolume(value) {
      volume = value;
      enqueue();
    },
    setActionHandler(action, handler) {
      actions.set(action, handler);
    },
    dispatch(event) {
      if (disposed || !metadata) return;
      let action = event.action;
      if (action === "toggle")
        action = playbackState === "playing" ? "pause" : "play";
      actions.get(action)?.(event);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) cancel(timer);
      actions.clear();
    },
  };
}
