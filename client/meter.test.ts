import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheStats,
  calibrate,
  initialMeterState,
  reduceMeter,
  summarizeTurn,
  type MeterState,
} from "./meter";

const CPT = 4;

function startTurn(state: MeterState = initialMeterState(), at = 0): MeterState {
  return reduceMeter(state, { t: "turn_started", at, turnId: "t1" });
}

test("snapshot text growth counts only the new characters", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "Hello" });
  s = reduceMeter(s, { t: "text", at: 1200, key: "m1", text: "Hello world" });
  assert.equal(s.totalChars, 11);
  assert.equal(s.firstTextAt, 1000);
  assert.equal(s.stepFirstTextAt, 1000);
});

test("delta text growth accumulates fragments", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "Hel" });
  s = reduceMeter(s, { t: "text", at: 1200, key: "m1", text: "lo w" });
  s = reduceMeter(s, { t: "text", at: 1400, key: "m1", text: "orld" });
  assert.equal(s.totalChars, 11);
});

test("usage closes a step: window runs from first text to usage arrival", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 3000, key: "m1", text: "x".repeat(800) });
  s = reduceMeter(s, { t: "usage", at: 3100, usage: { output: 100, input: 50 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 100);
  // Includes the tail where tool arguments were still being generated.
  assert.equal(s.steps[0].decodeMs, 2100);
  assert.equal(s.steps[0].prefillMs, 1000);
  assert.equal(s.steps[0].waitMs, 0);
  assert.equal(s.sawUsage, true);
  assert.equal(s.liveChars, 0);
  assert.equal(s.stepFirstTextAt, null);
  assert.deepEqual(s.calibInput, { chars: 800, tokens: 100 });
});

test("multi-step turn: tool runs sit between steps, argument decode stays inside", () => {
  let s = startTurn();
  // Step 1: text 1000..2000, arguments to 2100, usage at 2100.
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m1", text: "a b" });
  s = reduceMeter(s, { t: "usage", at: 2100, usage: { output: 10 } });
  // Tool runs 2100..12100. Step 2 decodes 12100..13200.
  s = reduceMeter(s, { t: "text", at: 12100, key: "m2", text: "c" });
  s = reduceMeter(s, { t: "text", at: 13100, key: "m2", text: "c d" });
  s = reduceMeter(s, { t: "usage", at: 13200, usage: { output: 25 } });
  assert.equal(s.steps.length, 2);
  assert.equal(s.steps[1].outTokens, 15);
  assert.equal(s.steps[1].decodeMs, 1100);
  assert.equal(s.steps[1].waitMs, 10000);
  assert.equal(s.steps[1].prefillMs, 0);

  const sum = summarizeTurn(s, CPT, 14200);
  assert.equal(sum.outTokens, 25);
  assert.equal(sum.decodeMs, 1100 + 1100);
  assert.equal(sum.waitMs, 10000);
  assert.equal(sum.prefillMs, 1000);
  assert.equal(sum.totalMs, 14200);
  assert.equal(sum.tokPerSecDecode, 25 / 2.2);
});

test("cumulative counters grow per step and are never counted twice", () => {
  // OpenCode reports message-cumulative tokens: each event contains the
  // previous ones. The meter must count differences, not the raw values.
  // Rates here are synthetic, so the plausibility guard is switched off.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 6000 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 2600, usage: { output: 12000 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "text", at: 4000, key: "m3", text: "c" });
  s = reduceMeter(s, { t: "usage", at: 4600, usage: { output: 19000 }, maxTokPerSec: Infinity });
  const sum = summarizeTurn(s, CPT, 4600);
  assert.equal(sum.outTokens, 19000);
  assert.equal(sum.steps, 3);
  assert.equal(s.steps[1].outTokens, 6000);
  assert.equal(s.steps[2].outTokens, 7000);
});

test("a counter reset (new assistant message) counts the fresh value whole", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 18000 }, maxTokPerSec: Infinity });
  // New message: counters restart from a smaller number.
  s = reduceMeter(s, { t: "text", at: 2000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 3000, usage: { output: 2500 }, maxTokPerSec: Infinity });
  assert.equal(s.steps.length, 2);
  assert.equal(s.steps[1].outTokens, 2500);
  assert.equal(s.prevUsageOut, 2500);
  assert.equal(summarizeTurn(s, CPT, 3000).outTokens, 20500);
});

test("turn_started keeps the observed usage baseline, not a racy snapshot", () => {
  let s = reduceMeter(initialMeterState(), { t: "usage", at: 10, usage: { output: 40, input: 900 } });
  assert.equal(s.prevUsageOut, 40);
  s = startTurn(s, 100);
  assert.equal(s.prevUsageOut, 40);
  s = reduceMeter(s, { t: "text", at: 500, key: "m1", text: "hello" });
  s = reduceMeter(s, { t: "usage", at: 1500, usage: { output: 45, input: 950 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 5);
  assert.equal(s.steps[0].inputTokens, 50);
});

test("early usage before turn_started is not lost or double counted", () => {
  // The agent_update carrying step-1 usage can beat the timeline's
  // turn_started event. The observed baseline makes the delta exact either
  // way: step 1's tokens are attributed to the previous turn's tail (idle),
  // and only genuinely new tokens open steps afterwards.
  let s = reduceMeter(initialMeterState(), { t: "usage", at: 100, usage: { output: 6000 } });
  s = startTurn(s, 200);
  s = reduceMeter(s, { t: "text", at: 300, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1300, usage: { output: 12000 }, maxTokPerSec: Infinity });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 6000);
});

test("repeated usage at completion opens no extra step", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 30 } });
  s = reduceMeter(s, { t: "turn_ended", at: 1200, kind: "completed", usage: { output: 30 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.phase, "completed");
});

test("zero-token usage does not open a step and never divides by zero", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "usage", at: 500, usage: { output: 0 } });
  assert.equal(s.steps.length, 0);
  const sum = summarizeTurn(s, CPT, 600);
  assert.equal(sum.tokPerSecDecode, null);
});

test("compaction drops the live character window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "x".repeat(100) });
  s = reduceMeter(s, { t: "compaction", at: 200 });
  assert.equal(s.liveChars, 0);
  assert.equal(s.totalChars, 100);
});

test("no usage: numbers are estimated from characters and flagged approx", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 2100, key: "m1", text: "x".repeat(800) });
  s = reduceMeter(s, { t: "turn_ended", at: 2200, kind: "completed" });
  const sum = summarizeTurn(s, CPT, 2200);
  assert.equal(sum.approx, true);
  assert.equal(sum.estTokens, 200);
  // Without any step, the text window stands in for the decode window.
  assert.equal(sum.decodeMs, 2000);
  assert.equal(sum.tokPerSecDecode, 200 / 2);
});

test("turn completion folds a trailing usage payload into the final step", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "turn_ended", at: 1200, kind: "completed", usage: { output: 30 } });
  assert.equal(s.phase, "completed");
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 30);
  assert.equal(s.steps[0].decodeMs, 1100);
  assert.equal(s.endedAt, 1200);
});

test("canceled and failed turns keep accumulated numbers", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "abc" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 12 } });
  s = reduceMeter(s, { t: "turn_ended", at: 5000, kind: "canceled", note: "user stop" });
  assert.equal(s.phase, "canceled");
  assert.equal(s.endNote, "user stop");
  assert.equal(summarizeTurn(s, CPT, 5000).outTokens, 12);
});

test("end events without a running turn are ignored", () => {
  const s = initialMeterState();
  const next = reduceMeter(s, { t: "turn_ended", at: 10, kind: "completed" });
  assert.equal(next.phase, "idle");
});

test("reset drops the turn but keeps the usage baseline continuous", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "abc" });
  s = reduceMeter(s, { t: "usage", at: 200, usage: { output: 77 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "reset" });
  assert.equal(s.phase, "idle");
  assert.equal(s.totalChars, 0);
  assert.equal(s.prevUsageOut, 77);
  s = startTurn(s, 300);
  s = reduceMeter(s, { t: "text", at: 400, key: "m2", text: "def" });
  s = reduceMeter(s, { t: "usage", at: 500, usage: { output: 90 } });
  assert.equal(s.steps[0].outTokens, 13);
});

test("text before turn start is ignored", () => {
  const s = reduceMeter(initialMeterState(), { t: "text", at: 100, key: "m1", text: "abc" });
  assert.equal(s.totalChars, 0);
});

test("reasoning-only steps still measure their decode window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "reasoning", text: "thinking..." });
  s = reduceMeter(s, { t: "usage", at: 2500, usage: { output: 60 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].decodeMs, 2000);
  assert.equal(s.steps[0].prefillMs, 500);
});

test("user wait is removed from the tool-wait window between steps", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 10 } });
  // Model asks a question, sleeps for 10s, user answers.
  s = reduceMeter(s, { t: "user_wait_started", at: 2100 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 12100 });
  s = reduceMeter(s, { t: "text", at: 12200, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 13200, usage: { output: 20 } });
  assert.equal(s.steps.length, 2);
  // Raw gap 2000..12200 is 10200ms; 10000 of it was the user thinking.
  assert.equal(s.steps[1].waitMs, 200);
  const sum = summarizeTurn(s, CPT, 13200);
  assert.equal(sum.waitMs, 200);
  assert.equal(sum.userWaitMs, 10000);
  assert.equal(sum.waiting, false);
});

test("a user wait inside a step is removed from its decode window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "user_wait_started", at: 1500 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 5500 });
  s = reduceMeter(s, { t: "usage", at: 6000, usage: { output: 30 } });
  assert.equal(s.steps.length, 1);
  // Raw window 1000..6000 = 5000ms, minus the 4000ms asleep.
  assert.equal(s.steps[0].decodeMs, 1000);
});

test("an open user wait counts live and closes when the turn ends", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 100 } });
  s = reduceMeter(s, { t: "user_wait_started", at: 2000 });
  const live = summarizeTurn(s, CPT, 7000);
  assert.equal(live.waiting, true);
  assert.equal(live.userWaitMs, 5000);
  // 7000ms wall, 5000 of it asleep -> whole-turn rate uses 2000ms.
  assert.equal(live.tokPerSecTurn, 100 / 2);
  s = reduceMeter(s, { t: "turn_ended", at: 8000, kind: "completed" });
  assert.equal(s.pausedAt, null);
  assert.equal(s.userWaits.length, 1);
  const done = summarizeTurn(s, CPT, 9000);
  assert.equal(done.userWaitMs, 6000);
  assert.equal(done.totalMs, 8000);
  assert.equal(done.tokPerSecTurn, 100 / 2);
});

test("user wait actions outside a live wait are no-ops", () => {
  const idle = reduceMeter(initialMeterState(), { t: "user_wait_started", at: 10 });
  assert.equal(idle.pausedAt, null);
  const running = startTurn();
  const ended = reduceMeter(running, { t: "user_wait_ended", at: 10 });
  assert.equal(ended, running);
});

test("turn_started and reset clear user waits", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "user_wait_started", at: 100 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 600 });
  s = startTurn(s, 700);
  assert.equal(s.userWaits.length, 0);
  assert.equal(s.pausedAt, null);
  s = reduceMeter(s, { t: "user_wait_started", at: 800 });
  s = reduceMeter(s, { t: "reset" });
  assert.equal(s.userWaits.length, 0);
  assert.equal(s.pausedAt, null);
});

test("a step faster than physically plausible is absorbed into the baseline", () => {
  // The interrupted-message scenario: its late step-finish lands mid new
  // turn and claims 1200 tokens in a 1600ms window (750 tok/s > 400).
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(230) });
  s = reduceMeter(s, { t: "usage", at: 2600, usage: { output: 1200 } });
  assert.equal(s.steps.length, 0);
  assert.deepEqual(s.stepRejected, { tokens: 1200, windowMs: 1600 });
  assert.equal(s.prevUsageOut, 1200);
  // The real step continues: window and characters were not reset.
  assert.equal(s.liveChars, 230);
  assert.equal(s.stepFirstTextAt, 1000);
  s = reduceMeter(s, { t: "text", at: 3400, key: "m1", text: "x".repeat(300) });
  s = reduceMeter(s, { t: "usage", at: 3600, usage: { output: 1260 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 60);
  assert.equal(s.stepRejected, null);
  const sum = summarizeTurn(s, CPT, 3600);
  assert.equal(sum.outTokens, 60);
});

test("text keys survive turn boundaries", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "hello world" });
  assert.equal(s.totalChars, 11);
  // The previous message's final snapshot arrives inside the next turn:
  // only the new characters may count.
  s = startTurn(s, 500);
  s = reduceMeter(s, { t: "text", at: 600, key: "m1", text: "hello world!" });
  assert.equal(s.totalChars, 1);
});

test("cache hit rate uses reported cache reads", () => {
  // OpenAI-style: `input` already contains the cached tokens.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 40, input: 10_000, cached: 8_000 } });
  const sum = summarizeTurn(s, CPT, 1000);
  assert.equal(sum.inputTokens, 10_000);
  assert.equal(sum.cachedTokens, 8_000);
  assert.equal(sum.promptTokens, 10_000);
  assert.equal(sum.cacheHitRate, 0.8);
});

test("cache hit rate is null without prompt data and 0 without cache", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 40 } });
  assert.equal(summarizeTurn(s, CPT, 1000).cacheHitRate, null);
  s = reduceMeter(s, { t: "text", at: 1100, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 70, input: 900, cached: 0 } });
  const sum = summarizeTurn(s, CPT, 2000);
  assert.equal(sum.promptTokens, 900);
  assert.equal(sum.cacheHitRate, 0);
});

test("cacheStats separates the two provider prompt shapes", () => {
  // OpenAI-style: prompt total equals input.
  assert.deepEqual(cacheStats(1000, 400), { promptTokens: 1000, cachedTokens: 400, hitRate: 0.4 });
  // Anthropic-style: `input` is the uncached prompt, cache reads are extra.
  assert.deepEqual(cacheStats(1000, 9000), { promptTokens: 10_000, cachedTokens: 9000, hitRate: 0.9 });
  // Nothing reported.
  assert.deepEqual(cacheStats(0, 0), { promptTokens: 0, cachedTokens: 0, hitRate: null });
  assert.deepEqual(cacheStats(Number.NaN, 500), { promptTokens: 500, cachedTokens: 500, hitRate: 1 });
});

test("cache writes join the prompt total, so they lower the hit rate", () => {
  // The Anthropic definition: cacheRead / (newInput + cacheWrite + cacheRead).
  // Half the prompt is served from cache, half is being written into it.
  const half = cacheStats(1200, 60_000, "separate", 60_000);
  assert.equal(half.promptTokens, 121_200);
  assert.equal(half.cachedTokens, 60_000);
  assert.equal(half.hitRate, 60_000 / 121_200);
  assert.ok(half.hitRate !== null && half.hitRate < 0.5);

  // A TTL rebuild that hits nothing: the old formula called this 0% by luck
  // (cached = 0), the new one keeps 0% for the right reason.
  const rebuild = cacheStats(1200, 0, "auto", 120_000);
  assert.equal(rebuild.promptTokens, 121_200);
  assert.equal(rebuild.hitRate, 0);
});

test("a zero cache write leaves the rate exactly as before", () => {
  // Every provider Paseo reports today is in this branch, so the extra term
  // must not move any number.
  const withoutTerm = cacheStats(194, 125_056);
  const withZeroTerm = cacheStats(194, 125_056, "auto", 0);
  assert.deepEqual(withZeroTerm, withoutTerm);
  assert.equal(withZeroTerm.promptTokens, 125_250);
});

test("cache hit rate stays null when the turn reports no prompt at all", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 40, cacheWrite: 9000 } });
  const sum = summarizeTurn(s, CPT, 1000);
  assert.equal(sum.cacheWriteTokens, 9000);
  assert.equal(sum.promptTokens, 9000);
  assert.equal(sum.cacheHitRate, 0);
});

test("cache writes accumulate per step like the other counters", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 10, input: 1000, cached: 0, cacheWrite: 50_000 } });
  s = reduceMeter(s, { t: "text", at: 1000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 1800, usage: { output: 20, input: 1200, cached: 51_000, cacheWrite: 50_000 } });
  const sum = summarizeTurn(s, CPT, 1800);
  // Step 2: 1200 new prompt tokens, 51000 cache reads, no new writes.
  assert.equal(sum.cacheWriteTokens, 50_000);
  assert.equal(sum.cachedTokens, 51_000);
  assert.equal(sum.promptTokens, 1200 + 50_000 + 51_000);
  assert.equal(sum.cacheHitRate, 51_000 / 102_200);
});

test("cache hit rate accumulates across a turn's steps", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 10, input: 1000, cached: 400 } });
  s = reduceMeter(s, { t: "text", at: 1000, key: "m2", text: "b" });
  // Step 2 brings 1200 fresh prompt tokens and 1200 more cache reads.
  s = reduceMeter(s, { t: "usage", at: 1800, usage: { output: 20, input: 2200, cached: 1600 } });
  const sum = summarizeTurn(s, CPT, 1800);
  assert.equal(sum.inputTokens, 2200);
  assert.equal(sum.cachedTokens, 1600);
  assert.equal(sum.promptTokens, 2200);
  assert.equal(sum.cacheHitRate, 1600 / 2200);
});

test("a cache read larger than the prompt means disjoint counters", () => {
  // Anthropic-style providers report cache reads outside `inputTokens`.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 40, input: 900, cached: 9_100 } });
  const sum = summarizeTurn(s, CPT, 1000);
  assert.equal(sum.inputTokens, 900);
  assert.equal(sum.cachedTokens, 9_100);
  assert.equal(sum.promptTokens, 10_000);
  assert.equal(sum.cacheHitRate, 0.91);
});

test("repeated snapshots never inflate the cache hit rate", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 10, input: 1000, cached: 900 } });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 10, input: 1000, cached: 900 } });
  const sum = summarizeTurn(s, CPT, 1000);
  assert.equal(sum.steps, 1);
  assert.equal(sum.cachedTokens, 900);
  assert.equal(sum.promptTokens, 1000);
  assert.equal(sum.cacheHitRate, 0.9);
});

test("calibration blends with EMA 0.7/0.3, clamps, and rejects thin samples", () => {
  const first = calibrate(undefined, 800, 100); // 0.7*3.6 + 0.3*8
  assert.equal(first, 4.92);
  const blended = calibrate(4, 400, 100); // 0.7*4 + 0.3*4 = 4
  assert.equal(blended, 4);
  const clampedLow = calibrate(2, 400, 100); // observed 4 -> stays >= 2
  assert.equal(clampedLow, 0.7 * 2 + 0.3 * 4);
  // Tool-argument-heavy steps stream almost no visible text: too thin.
  assert.equal(calibrate(4, 20, 50), null);
  assert.equal(calibrate(4, 400, 0), null);
  assert.equal(calibrate(4, 100, 100), 0.7 * 4 + 0.3 * 1); // observed 1 kept, clamped later
});
