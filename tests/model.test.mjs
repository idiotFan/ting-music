import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLyrics,
  lyricIndex,
  formatTime,
  uniqueSongs,
} from "../src/model.mjs";
test("LRC supports multiple timestamps, offsets, decimals, metadata and sorting", () => {
  const lines = parseLyrics(
    "[ar:Artist]\n[offset:500]\n[00:12.30][00:25.2]一句歌词\n[00:02.00]开场\n[00:10.00]",
  );
  assert.deepEqual(lines, [
    { time: 2.5, text: "开场" },
    { time: 12.8, text: "一句歌词" },
    { time: 25.7, text: "一句歌词" },
  ]);
  assert.equal(lyricIndex(lines, 2), -1);
  assert.equal(lyricIndex(lines, 12.8), 1);
  assert.equal(lyricIndex(lines, 100), 2);
});
test("time formatting handles unknown media duration", () => {
  assert.equal(formatTime(NaN), "0:00");
  assert.equal(formatTime(Infinity), "0:00");
  assert.equal(formatTime(185.9), "3:05");
});
test("queue deduplicates while retaining order", () => {
  assert.deepEqual(uniqueSongs([{ id: 2 }, { id: 1 }, { id: 2 }]), [
    { id: 2 },
    { id: 1 },
  ]);
});

test("shuffle cycle excludes current, deduplicates, and keeps every other track exactly once", async () => {
  const { shuffledIds } = await import("../src/model.mjs");
  const ids = shuffledIds([1, 2, 3, 4, 2], 1, () => 0.25);
  assert.deepEqual([...ids].sort(), [2, 3, 4]);
  assert.equal(ids.includes(1), false);
  assert.deepEqual(shuffledIds([1], 1), []);
  assert.deepEqual(shuffledIds([], undefined), []);
});
