import { songKey, uniqueSongs, shuffledIds } from "./model.mjs";

/** Queue membership and navigation history are independent of the audio element. */
export class PlaybackQueue {
  constructor(songs = []) {
    this.songs = uniqueSongs(songs);
    this.currentKey = "";
    this.history = [];
    this.historyIndex = -1;
    this.shuffleBag = [];
    // When the playing item is removed, this is the insertion point of its successor.
    this.detachedIndex = null;
  }

  replace(songs) {
    this.songs = uniqueSongs(songs);
    this.history = [];
    this.historyIndex = -1;
    this.shuffleBag = [];
    this.detachedIndex = null;
  }

  append(songs) {
    this.songs = uniqueSongs([...this.songs, ...songs]);
  }

  start(song, { fromHistory = false } = {}) {
    const key = songKey(song);
    if (!this.songs.some((item) => songKey(item) === key)) {
      if (fromHistory) return false;
      this.append([song]);
    }
    if (!fromHistory && (this.currentKey !== key || this.historyIndex < 0)) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(key);
      if (this.history.length > 500) this.history.shift();
      this.historyIndex = this.history.length - 1;
    }
    this.currentKey = key;
    this.detachedIndex = null;
    this.shuffleBag = this.shuffleBag.filter((id) => id !== key);
    return true;
  }

  remove(key) {
    const index = this.songs.findIndex((song) => songKey(song) === key);
    if (index < 0) return;
    if (key === this.currentKey) this.detachedIndex = index;
    else if (this.detachedIndex !== null && index < this.detachedIndex)
      this.detachedIndex--;
    this.songs = this.songs.filter((song) => songKey(song) !== key);
    this.shuffleBag = this.shuffleBag.filter((id) => id !== key);
    // Keep the history cursor, but navigation below only visits current queue members.
  }

  resetShuffle() {
    this.shuffleBag = [];
  }

  /** What next() would return, without moving: for preloading and crossfades. */
  peek(delta, mode, automatic = false) {
    if (mode === "shuffle" && !this.shuffleBag.length && this.songs.length) {
      // Draw the bag now so the real next() picks the song peek() promised.
      const keys = this.songs.map(songKey);
      this.shuffleBag = shuffledIds(keys, this.currentKey);
    }
    const probe = Object.assign(Object.create(PlaybackQueue.prototype), this, {
      history: [...this.history],
      shuffleBag: [...this.shuffleBag],
    });
    return probe.next(delta, mode, automatic);
  }

  /** Puts songs straight after the playing one ("下一首播放"). */
  playNext(songs) {
    const keys = new Set(songs.map(songKey));
    const rest = this.songs.filter((s) => !keys.has(songKey(s)));
    const at = rest.findIndex((s) => songKey(s) === this.currentKey);
    const index = at >= 0 ? at + 1 : (this.detachedIndex ?? 0);
    this.songs = [
      ...rest.slice(0, index),
      ...uniqueSongs(songs),
      ...rest.slice(index),
    ];
    // An explicit "next" beats whatever the history or shuffle had in mind.
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.shuffleBag = [
      ...uniqueSongs(songs).map(songKey),
      ...this.shuffleBag.filter((k) => !keys.has(k)),
    ];
  }

  /** Moves one song to a new position (drag and drop in the queue). */
  move(key, toIndex) {
    const from = this.songs.findIndex((s) => songKey(s) === key);
    if (from < 0) return;
    const songs = [...this.songs];
    const [song] = songs.splice(from, 1);
    songs.splice(Math.max(0, Math.min(toIndex, songs.length)), 0, song);
    this.songs = songs;
  }

  /** Empties the queue but keeps the playing song, so playback carries on. */
  clear() {
    this.songs = this.songs.filter((s) => songKey(s) === this.currentKey);
    this.history = this.currentKey ? [this.currentKey] : [];
    this.historyIndex = this.history.length - 1;
    this.shuffleBag = [];
    this.detachedIndex = null;
  }

  next(delta, mode, automatic = false) {
    if (!this.songs.length) return undefined;
    const byKey = new Map(this.songs.map((song) => [songKey(song), song]));
    for (
      let cursor = this.historyIndex + delta;
      cursor >= 0 && cursor < this.history.length;
      cursor += delta
    ) {
      const song = byKey.get(this.history[cursor]);
      if (song) {
        this.historyIndex = cursor;
        return { song, fromHistory: true };
      }
    }
    if (mode === "shuffle") {
      if (delta < 0 && byKey.has(this.currentKey)) return { restart: true };
      this.shuffleBag = this.shuffleBag.filter(
        (key) => byKey.has(key) && key !== this.currentKey,
      );
      if (!this.shuffleBag.length)
        this.shuffleBag = shuffledIds([...byKey.keys()], this.currentKey);
      const song = byKey.get(this.shuffleBag.shift()) || this.songs[0];
      return { song, fromHistory: false };
    }
    const index = this.songs.findIndex(
      (song) => songKey(song) === this.currentKey,
    );
    const nextIndex =
      index >= 0
        ? index + delta
        : this.detachedIndex !== null
          ? this.detachedIndex + (delta < 0 ? -1 : 0)
          : delta > 0
            ? 0
            : this.songs.length - 1;
    if (automatic && (nextIndex < 0 || nextIndex >= this.songs.length))
      return undefined;
    return {
      song: this.songs[(nextIndex + this.songs.length) % this.songs.length],
      fromHistory: false,
    };
  }
}
