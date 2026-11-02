import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldCloseMissedTurn,
  turnStartFromEvent,
  turnStartFromSnapshot,
} from "./lifecycle";

const T0 = Date.parse("2026-11-02T09:12:31.195Z");

test("event start uses the daemon timestamp carried by the stream message", () => {
  assert.deepEqual(turnStartFromEvent("2026-11-02T09:12:31.195Z", T0 + 3), {
    at: T0,
    source: "event",
  });
});

test("event start never begins in the future", () => {
  const start = turnStartFromEvent("2026-11-02T09:12:31.195Z", T0 - 2);
  assert.equal(start.at, T0 - 2);
});

test("event start ignores a timestamp far enough ahead to be a broken clock", () => {
  // 30s ahead of arrival: unreal, fall back to arrival.
  assert.deepEqual(turnStartFromEvent("2026-11-02T09:12:31.195Z", T0 - 30_000), {
    at: T0 - 30_000,
    source: "arrival",
  });
});

test("event start falls back to arrival for a stale or missing timestamp", () => {
  const arrivedAt = T0 + 120_000;
  assert.deepEqual(turnStartFromEvent("2026-11-02T09:12:31.195Z", arrivedAt), {
    at: arrivedAt,
    source: "arrival",
  });
  assert.deepEqual(turnStartFromEvent(null, arrivedAt), { at: arrivedAt, source: "arrival" });
  assert.deepEqual(turnStartFromEvent("not a date", arrivedAt), {
    at: arrivedAt,
    source: "arrival",
  });
  assert.deepEqual(turnStartFromEvent(undefined, arrivedAt), {
    at: arrivedAt,
    source: "arrival",
  });
});

test("snapshot start anchors a mid-turn attach to the accepted-turn boundary", () => {
  assert.deepEqual(turnStartFromSnapshot("2026-11-02T09:12:31.195Z", T0 + 5_000), {
    at: T0,
    source: "snapshot",
  });
});

test("snapshot start is clamped when the snapshot has no usable timestamp", () => {
  const observedAt = T0 + 2_000;
  assert.deepEqual(turnStartFromSnapshot(null, observedAt), {
    at: observedAt,
    source: "arrival",
  });
  assert.deepEqual(turnStartFromSnapshot("garbage", observedAt), {
    at: observedAt,
    source: "arrival",
  });
  assert.deepEqual(turnStartFromSnapshot("2026-11-02T09:12:41.195Z", observedAt), {
    at: observedAt,
    source: "arrival",
  });
});

test("a missed terminal event is closed by an idle snapshot", () => {
  assert.equal(shouldCloseMissedTurn("running", "idle"), true);
  assert.equal(shouldCloseMissedTurn("running", "error"), true);
  assert.equal(shouldCloseMissedTurn("running", "closed"), true);
  assert.equal(shouldCloseMissedTurn("running", "initializing"), true);
});

test("a running agent keeps the clock, and no turn means nothing to close", () => {
  assert.equal(shouldCloseMissedTurn("running", "running"), false);
  assert.equal(shouldCloseMissedTurn("idle", "idle"), false);
  assert.equal(shouldCloseMissedTurn("completed", "idle"), false);
  assert.equal(shouldCloseMissedTurn("failed", "idle"), false);
  assert.equal(shouldCloseMissedTurn("canceled", "idle"), false);
});

test("a partial snapshot without a status never closes a turn", () => {
  assert.equal(shouldCloseMissedTurn("running", null), false);
  assert.equal(shouldCloseMissedTurn("running", undefined), false);
  assert.equal(shouldCloseMissedTurn("running", ""), false);
});
