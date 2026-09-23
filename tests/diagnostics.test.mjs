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

test("home folders, JSON credentials and bearer tokens are masked too", () => {
  assert.equal(
    redact("saved to /Users/alice/Downloads/Ting/a.flac"),
    "saved to ~/Downloads/Ting/a.flac",
  );
  assert.equal(redact("C:\\Users\\bob\\Music"), "~\\Music");
  assert.equal(
    redact('{"uin":"123456","MUSIC_U":"abc"}'),
    '{"uin":"…","MUSIC_U":"…"}',
  );
  assert.equal(
    redact("authst=xyz psrf_qqaccess_token=q"),
    "authst=… psrf_qqaccess_token=…",
  );
  assert.equal(
    redact("Authorization: Bearer abc.def"),
    "Authorization: Bearer …",
  );
});
