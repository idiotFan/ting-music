import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redact.mjs";

test("diagnostics never keep addresses' queries, cookies or tokens", () => {
  assert.equal(
    redact("GET https://m801.music.126.net/a.flac?vuutv=abc&k=1 failed"),
    "GET https://m801.music.126.net/a.flac?… failed",
  );
  assert.equal(redact("MUSIC_U=secretvalue; os=pc"), "MUSIC_U=…; os=pc");
  assert.equal(redact("x " + "a".repeat(40)), "x …");
  assert.ok(redact("y".repeat(900)).length <= 500);
});
