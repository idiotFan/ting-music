import test from "node:test";
import assert from "node:assert/strict";
import { createMediaSession } from "../src/media-session.mjs";
const song = (id) => ({
  name: `song ${id}`,
  artist: `artist ${id}`,
  album: `album ${id}`,
  cover: `cover ${id}`,
});
function fixture(loadArtwork = async (url) => ({ src: url })) {
  const audio = Object.assign(new EventTarget(), {
    paused: true,
    ended: false,
    duration: NaN,
    currentTime: 0,
    playbackRate: 1,
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    },
  });
  const actions = {},
    positions = [];
  const session = {
    metadata: null,
    playbackState: "none",
    setPositionState(value) {
      positions.push(value);
    },
    setActionHandler(name, fn) {
      actions[name] = fn;
    },
  };
  let next = 0,
    previous = 0;
  const media = createMediaSession(audio, {
    session,
    metadata: (v) => v,
    loadArtwork,
    fallbackArtwork: { src: "fallback" },
    play: () => {
      audio.paused = false;
    },
    next: () => next++,
    previous: () => previous++,
  });
  return {
    audio,
    session,
    media,
    actions,
    positions,
    counts: () => [next, previous],
  };
}
test("metadata changes before play completes and stale artwork cannot replace a newer track", async () => {
  const pending = [];
  const f = fixture(
    (url) => new Promise((resolve) => pending.push({ url, resolve })),
  );
  f.media.select(song(1));
  assert.equal(f.session.metadata.title, "song 1");
  assert.equal(f.session.playbackState, "paused");
  f.media.clear();
  f.media.select(song(2));
  f.media.clear();
  f.media.select(song(3));
  assert.equal(pending.length, 1); // Only one native request in flight.
  pending[0].resolve({ src: "old-cover" });
  await new Promise(setImmediate);
  assert.equal(f.session.metadata.title, "song 3");
  assert.equal(f.session.metadata.artwork[0].src, "fallback");
  assert.equal(pending[1].url, "cover 3"); // Intermediate song skipped.
  pending[1].resolve({ src: "current-cover" });
  await new Promise(setImmediate);
  assert.equal(f.session.metadata.artwork[0].src, "current-cover");
});
test("failed or absent cover clears previous artwork without blocking transport", async () => {
  const f = fixture(async (url) => {
    if (url === "cover 2") throw Error("offline");
    return { src: url };
  });
  f.media.select(song(1));
  await new Promise(setImmediate);
  f.media.select(song(2));
  await new Promise(setImmediate);
  assert.equal(f.session.metadata.artwork[0].src, "fallback");
  f.media.select({ ...song(3), cover: "" });
  assert.equal(f.session.metadata.title, "song 3");
  assert.equal(f.session.metadata.artwork[0].src, "fallback");
  f.actions.nexttrack();
  f.actions.previoustrack();
  assert.deepEqual(f.counts(), [1, 1]);
});
test("play, pause, seek, duration and rate are mirrored with valid positions", () => {
  const f = fixture();
  f.media.select(song(1));
  assert.equal(f.positions.at(-1), undefined);
  f.audio.duration = 100;
  f.audio.currentTime = 12;
  f.audio.paused = false;
  f.audio.dispatchEvent(new Event("playing"));
  assert.equal(f.session.playbackState, "playing");
  assert.deepEqual(f.positions.at(-1), {
    duration: 100,
    position: 12,
    playbackRate: 1,
  });
  f.actions.seekto({ seekTime: 200 });
  assert.equal(f.audio.currentTime, 100);
  f.actions.seekto({ seekTime: -10 });
  assert.equal(f.audio.currentTime, 0);
  f.actions.seekto({ seekTime: 20 });
  assert.equal(f.audio.currentTime, 20);
  f.audio.playbackRate = 2;
  f.audio.dispatchEvent(new Event("ratechange"));
  assert.equal(f.positions.at(-1).playbackRate, 2);
  f.actions.pause();
  assert.equal(f.session.playbackState, "paused");
  f.audio.dispatchEvent(new Event("error"));
  assert.equal(f.session.metadata, null);
  assert.equal(f.session.playbackState, "none");
  assert.equal(f.positions.at(-1), undefined);
});
test("late cover after logout cannot restore cleared system information", async () => {
  let finish;
  const f = fixture(() => new Promise((r) => (finish = r)));
  f.media.select(song(1));
  f.media.clear();
  finish({ src: "late-cover" });
  await new Promise(setImmediate);
  assert.equal(f.session.metadata, null);
  f.media.refresh();
  assert.equal(f.session.metadata, null);
});
test("unsupported metadata and optional actions never interrupt app playback", () => {
  const f = fixture();
  Object.defineProperty(f.session, "metadata", {
    set() {
      throw Error("unsupported");
    },
  });
  assert.doesNotThrow(() => f.media.select(song(1)));
  assert.doesNotThrow(() => f.media.clear());
});

test("music exposes track navigation without competing interval skip commands", () => {
  const f = fixture();
  assert.equal(f.actions.seekbackward, null);
  assert.equal(f.actions.seekforward, null);
  f.media.select(song(1));
  f.actions.nexttrack();
  f.media.select(song(2));
  f.audio.dispatchEvent(new Event("playing"));
  f.actions.previoustrack();
  assert.deepEqual(f.counts(), [1, 1]);
});

test("system stop resets progress while retaining the track for play", () => {
  const f = fixture();
  f.media.select(song(1));
  f.audio.duration = 100;
  f.audio.currentTime = 40;
  f.actions.stop();
  assert.equal(f.audio.currentTime, 0);
  assert.equal(f.session.playbackState, "none");
  assert.equal(f.session.metadata.title, "song 1");
  f.actions.play();
  f.audio.dispatchEvent(new Event("play"));
  assert.equal(f.session.playbackState, "playing");
});

test("WebKit commands are restored when the media listener appears or is rebuilt", () => {
  const audio = new EventTarget();
  Object.assign(audio, {
    paused: true,
    ended: false,
    duration: 100,
    currentTime: 0,
    playbackRate: 1,
  });
  const commands = new Map();
  let ready = false,
    next = 0,
    previous = 0;
  const session = {
    setActionHandler(action, handler) {
      if (ready) commands.set(action, handler);
    },
    setPositionState() {},
  };
  const media = createMediaSession(audio, {
    session,
    metadata: (v) => v,
    fallbackArtwork: null,
    loadArtwork: async () => null,
    play() {},
    next() {
      next++;
    },
    previous() {
      previous++;
    },
  });
  assert.equal(commands.size, 0); // WebKit has no remote listener for an empty Audio.
  media.select({ ...song(1), cover: "" });
  ready = true;
  audio.dispatchEvent(new Event("loadedmetadata"));
  commands.get("nexttrack")();
  commands.clear();
  audio.dispatchEvent(new Event("playing"));
  commands.get("previoustrack")();
  commands.clear();
  media.refresh();
  assert.equal(typeof commands.get("nexttrack"), "function");
  assert.equal(commands.get("seekforward"), null);
  assert.deepEqual([next, previous], [1, 1]);
});
