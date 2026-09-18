import test from "node:test";
import assert from "node:assert/strict";
import { createNativeSession } from "../src/native-media-session.mjs";
const tick = () => new Promise(setImmediate);
function fixture(update) {
  let tasks = [],
    errors = 0;
  const session = createNativeSession({
    update,
    onError: () => errors++,
    schedule(fn) {
      tasks.push(fn);
      return fn;
    },
    cancel(fn) {
      tasks = tasks.filter((task) => task !== fn);
    },
  });
  return {
    session,
    errors: () => errors,
    flush() {
      const batch = tasks;
      tasks = [];
      batch.forEach((fn) => fn());
    },
  };
}
test("native media coalesces in-flight changes and never sends stale artwork after clear", async () => {
  const calls = [],
    pending = [];
  const f = fixture((snapshot) => {
    calls.push(snapshot);
    return new Promise((r) => pending.push(r));
  });
  f.session.metadata = { title: "one", artwork: [{ src: "one.png" }] };
  f.session.playbackState = "playing";
  f.flush();
  f.session.metadata = { title: "two" };
  for (let i = 0; i < 100; i++) f.session.setPositionState({ position: i });
  f.session.metadata = null;
  f.session.playbackState = "none";
  f.session.setPositionState();
  f.flush();
  assert.equal(calls.length, 1);
  pending.shift()();
  await tick();
  f.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].metadata, null);
  assert.equal(calls[1].position, null);
  assert.equal(calls[1].playbackState, "none");
  pending.shift()();
  await tick();
  f.session.setPositionState({ position: 0 });
  f.flush();
  assert.equal("metadata" in calls[2], false);
  pending.shift()();
});
test("native actions use the same queue callbacks exactly once and stop after disposal", () => {
  const calls = [],
    f = fixture(async () => {});
  f.session.setActionHandler("nexttrack", () => calls.push("next"));
  f.session.setActionHandler("pause", () => calls.push("pause"));
  f.session.setActionHandler("play", () => calls.push("play"));
  f.session.dispatch({ action: "nexttrack" });
  assert.deepEqual(calls, []);
  f.session.metadata = { title: "one" };
  f.session.dispatch({ action: "nexttrack" });
  f.session.playbackState = "playing";
  f.session.dispatch({ action: "toggle" });
  f.session.playbackState = "paused";
  f.session.dispatch({ action: "toggle" });
  f.session.dispose();
  f.session.dispatch({ action: "nexttrack" });
  assert.deepEqual(calls, ["next", "pause", "play"]);
});
test("failed IPC reports an error and resends metadata on the next update", async () => {
  const calls = [];
  const f = fixture(async (value) => {
    calls.push(value);
    if (calls.length === 1) throw Error("offline");
  });
  f.session.metadata = { title: "one" };
  f.flush();
  await tick();
  assert.equal(f.errors(), 1);
  f.session.playbackState = "playing";
  f.flush();
  await tick();
  assert.equal(calls[1].metadata.title, "one");
});
