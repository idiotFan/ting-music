import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  songArtists,
  mergeResults,
  highlightRuns,
  namesArtist,
  arrange,
  albumsOf,
  releaseDate,
} from "../src/catalog-model.mjs";

const song = (id, name, artist, extra = {}) => ({
  id,
  name,
  artist,
  album: "A",
  cover: "",
  duration: 0,
  fee: 0,
  ...extra,
});

test("names normalize across width, case and punctuation", () => {
  assert.equal(normalizeName("Ｊａｙ Chou·周杰伦"), "jaychou周杰伦");
  assert.equal(normalizeName("  (Live)  "), "live");
});

test("artists come from ids when given and from the joined name otherwise", () => {
  assert.deepEqual(
    songArtists(song(1, "x", "A / B")).map((a) => a.name),
    ["A", "B"],
  );
  assert.deepEqual(
    songArtists(song(1, "x", "A", { artists: [{ id: 7, name: "A" }] })),
    [{ id: 7, mid: "", name: "A" }],
  );
});

test("merging interleaves platforms and keeps one copy of a recording", () => {
  const seen = new Set();
  const a = [
    song(1, "晴天", "周杰伦", { source: "netease" }),
    song(2, "七里香", "周杰伦", { source: "netease" }),
  ];
  const b = [
    song(9, "晴天", "周杰伦", { source: "qq" }),
    song(8, "稻香", "周杰伦", { source: "qq" }),
  ];
  assert.deepEqual(
    mergeResults(a, b, seen).map((s) => s.id),
    [1, 2, 8],
  );
  // The primary platform's copy wins even when the other lists it first.
  const lead = [song(1, "七里香", "周杰伦"), song(2, "晴天", "周杰伦")];
  assert.deepEqual(
    mergeResults(lead, [song(9, "晴天", "周杰伦")]).map((s) => s.id),
    [1, 2],
  );
  // The next page must not bring back what the first one showed.
  assert.deepEqual(mergeResults([song(3, "七里香", "周杰伦")], [], seen), []);
});

test("highlight marks every term without splitting characters", () => {
  assert.deepEqual(highlightRuns("周杰伦 晴天", "晴天"), [
    { text: "周杰伦 ", match: false },
    { text: "晴天", match: true },
  ]);
  assert.deepEqual(highlightRuns("ABC", "b"), [
    { text: "A", match: false },
    { text: "B", match: true },
    { text: "C", match: false },
  ]);
  assert.deepEqual(highlightRuns("x", "  "), [{ text: "x", match: false }]);
});

test("best match only when the query is the artist's name", () => {
  assert.ok(namesArtist("周杰伦", { name: "周杰伦" }));
  assert.ok(namesArtist("jay chou", { name: "周杰伦", alias: "Jay Chou" }));
  assert.ok(!namesArtist("周杰伦 晴天", { name: "周杰伦" }));
});

test("arrange filters every term and sorts stably", () => {
  const list = [
    song(1, "b", "Y", { duration: 3 }),
    song(2, "a", "X", { duration: 1 }),
    song(3, "c", "X", { duration: 0 }),
  ];
  assert.deepEqual(
    arrange(list, "x").map((s) => s.id),
    [2, 3],
  );
  assert.deepEqual(
    arrange(list, "", "name").map((s) => s.id),
    [2, 1, 3],
  );
  assert.deepEqual(
    arrange(list, "", "short").map((s) => s.id),
    [2, 1, 3],
  );
  assert.deepEqual(
    arrange(list, "", "long").map((s) => s.id),
    [1, 2, 3],
  );
  assert.deepEqual(
    arrange(list, "", "artist").map((s) => s.id),
    [2, 3, 1],
  );
  assert.deepEqual(
    arrange(list).map((s) => s.id),
    [1, 2, 3],
  );
});

test("local albums group by normalized name and borrow a cover", () => {
  const groups = albumsOf([
    song(1, "a", "X", { album: "Night" }),
    song(2, "b", "X", { album: "night", cover: "c.jpg" }),
    song(3, "c", "X", { album: "" }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].cover, "c.jpg");
  assert.equal(groups[1].name, "未知专辑");
});

test("release dates print in UTC", () => {
  assert.equal(releaseDate(1059609600000), "2003-07-31");
  assert.equal(releaseDate(0), "");
});
