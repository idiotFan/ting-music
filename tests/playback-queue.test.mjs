import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackQueue } from "../src/playback-queue.mjs";
import { songKey } from "../src/model.mjs";
const songs = [1, 2, 3, 4].map((id) => ({ id, name: String(id) }));

test("removal excludes a track from backward and forward history without re-enqueueing", () => {
  const state = new PlaybackQueue(songs);
  for (const song of songs.slice(0, 3)) state.start(song);
  state.remove("netease:2");
  const back = state.next(-1, "sequence");
  assert.equal(back.song.id, 1);
  state.start(back.song, back);
  assert.equal(state.next(1, "sequence").song.id, 3);
  assert.deepEqual(
    state.songs.map((s) => s.id),
    [1, 3, 4],
  );
});

test("removed current item keeps a stable successor through additional removals", () => {
  const state = new PlaybackQueue(songs);
  state.start(songs[1]);
  state.remove("netease:2");
  state.remove("netease:1");
  assert.equal(state.next(1, "sequence", true).song.id, 3);
  state.remove("netease:3");
  assert.equal(state.next(1, "sequence", true).song.id, 4);
  state.remove("netease:4");
  assert.equal(state.next(1, "shuffle", true), undefined);
});

test("removing last playing item ends sequence but manual next can wrap", () => {
  const state = new PlaybackQueue(songs);
  state.start(songs[3]);
  state.remove("netease:4");
  assert.equal(state.next(1, "sequence", true), undefined);
  assert.equal(state.next(1, "sequence").song.id, 1);
});

test("shuffle never revives removed current track or leaks songs from replaced queue", () => {
  const state = new PlaybackQueue(songs);
  state.start(songs[0]);
  state.remove("netease:1");
  const visited = new Set();
  for (let i = 0; i < 3; i++) {
    const next = state.next(1, "shuffle", true);
    assert.notEqual(next.song.id, 1);
    visited.add(next.song.id);
    state.start(next.song, next);
  }
  assert.equal(visited.size, 3);
  const qq = { id: 1, source: "qq" };
  state.replace([qq]);
  state.start(qq);
  for (let i = 0; i < 3; i++) {
    const next = state.next(1, "shuffle", true);
    assert.equal(songKey(next.song), "qq:1");
    state.start(next.song, next);
  }
});
