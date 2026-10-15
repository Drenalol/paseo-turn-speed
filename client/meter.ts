/**
 * Pure per-agent turn meter. No SDK, no timers, no I/O: every action carries
 * its own timestamp so the whole reducer is unit-testable with `node --test`.
 *
 * Usage counters arrive as snapshots of provider-reported totals that grow
 * within an assistant message (and may reset when a new message starts). The
 * meter therefore works in differences between consecutive events; a value
 * below the last seen one is treated as a reset and counts whole.
 *
 * Step model: one model call runs from its first streamed text to the usage
 * event that closes it. That window includes tool-argument generation, which
 * is decode time and output tokens even though no assistant text grows. The
 * gap between a step's usage and the next step's first text is wait time:
 * tool execution, queueing, and the next call's prefill.
 *
 * Whenever the provider reports the model is blocked on the user (a question
 * or permission request), that interval is tracked separately: it is removed
 * from step decode/wait windows and from the whole-turn rate, while the turn
 * clock itself keeps running in wall time.
 */

/** A live-window text gap longer than this is treated as a stall. */
export const MAX_TEXT_GAP_MS = 2000;
export const DEFAULT_CHARS_PER_TOKEN = 3.6;
/** Steps implying a faster decode than this are treated as misattributed
 * usage (e.g. a previous message's late step-finish landing in this turn)
 * and folded into the baseline instead of opening a step. */
export const DEFAULT_MAX_TOK_PER_SEC = 400;
/** Message keys remembered across turns, so a snapshot of an older message
 * arriving late is recognised as "no growth" instead of a fresh text flood. */
const MAX_TEXT_KEYS = 32;
export const CAL_MIN = 2;
export const CAL_MAX = 8;
export const CAL_MIN_CHARS = 40;

export interface UsageSnapshot {
  input?: number | null;
  cached?: number | null;
  output?: number | null;
  ctxMax?: number | null;
  ctxUsed?: number | null;
}

export interface StepRecord {
  /** Output tokens produced by this model call. */
  outTokens: number;
  /** First text -> usage arrival: decode including tool arguments. */
  decodeMs: number;
  /** Previous step end -> this step's first text (tool run + prefill). */
  waitMs: number;
  /** Prompt tokens this call consumed. */
  inputTokens: number;
  /** Cached prompt tokens this call reported. */
  cachedTokens: number;
  /** Prefill/TTFT measured on the first step only, else 0. */
  prefillMs: number;
}

export type TurnPhase = "idle" | "running" | "completed" | "failed" | "canceled";

/** One completed interval of the model being blocked on the user
 * (question, permission prompt, plan approval). */
export interface UserWaitInterval {
  start: number;
  end: number;
}

export interface MeterState {
  phase: TurnPhase;
  turnId: string | null;
  startedAt: number | null;
  /** First assistant/reasoning growth of the turn => end of prefill. */
  firstTextAt: number | null;
  lastTextAt: number | null;
  /** First text since the last step boundary (null = re-anchored). */
  stepFirstTextAt: number | null;
  /** Usage arrival of the last completed step. */
  prevStepEndAt: number | null;
  /** Per-message observed text length (snapshot vs delta normalised). */
  textLens: Readonly<Record<string, number>>;
  /** Last text seen per key, to tell snapshots from deltas. */
  textTails: Readonly<Record<string, string>>;
  /** Last usage seen, for display. */
  usageOut: number | null;
  usageIn: number | null;
  usageCached: number | null;
  ctxMax: number | null;
  ctxUsed: number | null;
  /** Last seen cumulative counters; the baseline for the next delta. */
  prevUsageOut: number;
  prevUsageIn: number;
  prevUsageCached: number;
  steps: readonly StepRecord[];
  /** Characters streamed since the last step boundary (live estimate). */
  liveChars: number;
  /** All characters streamed this turn (fallback estimate). */
  totalChars: number;
  /** Completed user-wait intervals inside this turn. */
  userWaits: readonly UserWaitInterval[];
  /** Start of the open user-wait interval, null when the model is live. */
  pausedAt: number | null;
  /** True once any real usage step landed during this turn. */
  sawUsage: boolean;
  /** Set when a usage delta was dropped as physically impossible. */
  stepRejected: { tokens: number; windowMs: number } | null;
  /** Set on each usage step for the store to fold into calibration. */
  calibInput: { chars: number; tokens: number } | null;
  endedAt: number | null;
  endNote: string | null;
}

export type MeterAction =
  | { t: "turn_started"; at: number; turnId: string | null }
  | { t: "text"; at: number; key: string; text: string }
  | { t: "usage"; at: number; usage: UsageSnapshot; maxTokPerSec?: number }
  | { t: "compaction"; at: number }
  /** The model blocked on the user (question asked, permission pending). */
  | { t: "user_wait_started"; at: number }
  /** The user answered: the model woke up. */
  | { t: "user_wait_ended"; at: number }
  | { t: "turn_ended"; at: number; kind: "completed" | "failed" | "canceled"; usage?: UsageSnapshot; maxTokPerSec?: number; note?: string | null }
  /** Drop the locally observed turn (epoch replacement, reconnect, reload). */
  | { t: "reset" };

export function initialMeterState(): MeterState {
  return {
    phase: "idle",
    turnId: null,
    startedAt: null,
    firstTextAt: null,
    lastTextAt: null,
    stepFirstTextAt: null,
    prevStepEndAt: null,
    textLens: {},
    textTails: {},
    usageOut: null,
    usageIn: null,
    usageCached: null,
    ctxMax: null,
    ctxUsed: null,
    prevUsageOut: 0,
    prevUsageIn: 0,
    prevUsageCached: 0,
    steps: [],
    liveChars: 0,
    totalChars: 0,
    userWaits: [],
    pausedAt: null,
    sawUsage: false,
    stepRejected: null,
    calibInput: null,
    endedAt: null,
    endNote: null,
  };
}

function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Count growth for one message key. Snapshot streams (full text each time)
 * and delta streams (fragments) both normalise to a growth amount. */
function growText(
  state: MeterState,
  key: string,
  text: string,
): { lens: Record<string, number>; tails: Record<string, string>; growth: number } {
  const prevLen = state.textLens[key] ?? 0;
  const prevText = state.textTails[key] ?? "";
  let growth: number;
  let nextLen: number;
  if (prevText !== "" && text.startsWith(prevText)) {
    // Snapshot: the item carries the whole accumulated text.
    growth = Math.max(0, text.length - prevLen);
    nextLen = text.length;
  } else if (prevText === "") {
    growth = text.length;
    nextLen = text.length;
  } else {
    // Delta fragment or a fresh part (e.g. a new reasoning block).
    growth = text.length;
    nextLen = prevLen + text.length;
  }
  const lens = { ...state.textLens, [key]: nextLen };
  const tails = { ...state.textTails, [key]: text };
  // Bound the map: keys survive turn boundaries (late snapshots of older
  // messages must not re-count), so evict the oldest ones.
  const keys = Object.keys(lens);
  for (const stale of keys.slice(0, keys.length - MAX_TEXT_KEYS)) {
    delete lens[stale];
    delete tails[stale];
  }
  return { lens, tails, growth };
}

function applyText(state: MeterState, at: number, key: string, text: string): MeterState {
  if (state.phase !== "running" || text.length === 0) return state;
  const { lens, tails, growth } = growText(state, key, text);
  if (growth <= 0) return state;
  return {
    ...state,
    textLens: lens,
    textTails: tails,
    firstTextAt: state.firstTextAt === null ? at : state.firstTextAt,
    stepFirstTextAt: state.stepFirstTextAt === null ? at : state.stepFirstTextAt,
    lastTextAt: at,
    liveChars: state.liveChars + growth,
    totalChars: state.totalChars + growth,
  };
}

/** Difference against the last seen value; a decrease means the provider
 * restarted its counters (new assistant message or session), in which case
 * the whole value belongs to this step. */
function delta(value: number | null, previous: number): { amount: number; next: number } {
  if (value === null) return { amount: 0, next: previous };
  return value >= previous
    ? { amount: value - previous, next: value }
    : { amount: value, next: value };
}

/** Milliseconds inside [from, to] during which the model was blocked on the
 * user; those must not be charged to decode or tool-run windows. An open
 * interval counts up to `to`. */
function waitOverlap(state: MeterState, from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  for (const wait of state.userWaits) {
    total += Math.max(0, Math.min(wait.end, to) - Math.max(wait.start, from));
  }
  if (state.pausedAt !== null) total += Math.max(0, to - Math.max(state.pausedAt, from));
  return Math.min(total, to - from);
}

/** Move the open user-wait interval into the completed list. */
function closeWait(state: MeterState, at: number): MeterState {
  return state.pausedAt === null
    ? state
    : {
        ...state,
        pausedAt: null,
        userWaits: [...state.userWaits, { start: state.pausedAt, end: Math.max(at, state.pausedAt) }],
      };
}

function applyUsage(
  state: MeterState,
  at: number,
  usage: UsageSnapshot,
  maxTokPerSec?: number,
): MeterState {
  const out = num(usage.output);
  const inp = num(usage.input);
  const cached = num(usage.cached);
  const counters = {
    usageOut: out ?? state.usageOut,
    usageIn: inp ?? state.usageIn,
    usageCached: cached ?? state.usageCached,
    ctxMax: num(usage.ctxMax) ?? state.ctxMax,
    ctxUsed: num(usage.ctxUsed) ?? state.ctxUsed,
  };
  const outDelta = delta(out, state.prevUsageOut);
  const inDelta = delta(inp, state.prevUsageIn);
  const cachedDelta = delta(cached, state.prevUsageCached);
  const withCounters: MeterState = {
    ...state,
    ...counters,
    prevUsageOut: outDelta.next,
    prevUsageIn: inDelta.next,
    prevUsageCached: cachedDelta.next,
  };
  if (state.phase !== "running") return { ...withCounters };
  if (outDelta.amount <= 0) {
    // No new answer tokens: refresh counters without opening a step.
    return { ...withCounters, calibInput: null, stepRejected: null };
  }
  const stepStart = state.stepFirstTextAt ?? state.prevStepEndAt ?? state.startedAt ?? at;
  const stepDecodeMs = Math.max(0, at - stepStart - waitOverlap(state, stepStart, at));
  const stepWaitMs =
    state.steps.length === 0 || state.stepFirstTextAt === null || state.prevStepEndAt === null
      ? 0
      : Math.max(
          0,
          state.stepFirstTextAt -
            state.prevStepEndAt -
            waitOverlap(state, state.prevStepEndAt, state.stepFirstTextAt),
        );
  // A delta implying more tokens than the window could physically decode is
  // not this turn's work: typically the previous (interrupted) message's
  // step-finish landing late. Absorb it into the baseline, keep the window.
  const threshold = maxTokPerSec ?? DEFAULT_MAX_TOK_PER_SEC;
  const impliedRate =
    stepDecodeMs > 0 ? outDelta.amount / (stepDecodeMs / 1000) : Number.POSITIVE_INFINITY;
  if (impliedRate > threshold) {
    return {
      ...withCounters,
      calibInput: null,
      stepRejected: { tokens: outDelta.amount, windowMs: stepDecodeMs },
    };
  }
  const prefillMs =
    state.steps.length === 0 && state.firstTextAt !== null && state.startedAt !== null
      ? Math.max(0, state.firstTextAt - state.startedAt)
      : 0;
  const step: StepRecord = {
    outTokens: outDelta.amount,
    decodeMs: stepDecodeMs,
    waitMs: stepWaitMs,
    inputTokens: inDelta.amount,
    cachedTokens: cachedDelta.amount,
    prefillMs,
  };
  return {
    ...withCounters,
    steps: [...state.steps, step],
    stepFirstTextAt: null,
    prevStepEndAt: at,
    liveChars: 0,
    sawUsage: true,
    stepRejected: null,
    calibInput: { chars: state.liveChars, tokens: outDelta.amount },
  };
}

function endTurn(
  state: MeterState,
  at: number,
  kind: "completed" | "failed" | "canceled",
  usage: UsageSnapshot | undefined,
  maxTokPerSec: number | undefined,
  note: string | null,
): MeterState {
  // A repeated cumulative payload contributes no delta and opens no step.
  const withUsage = usage ? applyUsage(state, at, usage, maxTokPerSec) : state;
  if (withUsage.phase !== "running") return state;
  // A turn that ends while a question is still open closes the wait there.
  return { ...closeWait(withUsage, at), phase: kind, endedAt: at, endNote: note };
}

export function reduceMeter(state: MeterState, action: MeterAction): MeterState {
  switch (action.t) {
    case "turn_started": {
      // Cumulative counters and their last-seen baseline survive the reset:
      // the baseline must come from what this plugin actually observed, not
      // from a snapshot that may already contain this turn's early usage.
      return {
        ...initialMeterState(),
        phase: "running",
        turnId: action.turnId,
        startedAt: action.at,
        ctxMax: state.ctxMax,
        ctxUsed: state.ctxUsed,
        textLens: state.textLens,
        textTails: state.textTails,
        prevUsageOut: state.prevUsageOut,
        prevUsageIn: state.prevUsageIn,
        prevUsageCached: state.prevUsageCached,
      };
    }
    case "text":
      return applyText(state, action.at, action.key, action.text);
    case "usage":
      return applyUsage(state, action.at, action.usage, action.maxTokPerSec);
    case "compaction":
      // Context was rewritten; streamed chars since the last step no longer
      // map to answer tokens. Drop the live window, keep step history.
      return state.phase === "running" ? { ...state, liveChars: 0 } : state;
    case "user_wait_started":
      return state.phase === "running" && state.pausedAt === null
        ? { ...state, pausedAt: action.at }
        : state;
    case "user_wait_ended":
      // An end for a wait we never saw (resolved before attach) is a no-op.
      return state.pausedAt === null ? state : closeWait(state, action.at);
    case "turn_ended":
      return endTurn(state, action.at, action.kind, action.usage, action.maxTokPerSec, action.note ?? null);
    case "reset":
      // Keep the observed usage baseline: the provider's counters outlive the
      // locally observed turn, so deltas must stay continuous.
      return {
        ...initialMeterState(),
        ctxMax: state.ctxMax,
        textLens: state.textLens,
        textTails: state.textTails,
        prevUsageOut: state.prevUsageOut,
        prevUsageIn: state.prevUsageIn,
        prevUsageCached: state.prevUsageCached,
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Derived numbers (pure selectors)
// ---------------------------------------------------------------------------

export interface TurnSummary {
  /** Real output tokens this turn, or null when nothing real was seen. */
  outTokens: number | null;
  /** Estimated output tokens: real where available, chars/cpt for the tail. */
  estTokens: number;
  /** True when any part of the numbers is character-estimated. */
  approx: boolean;
  decodeMs: number;
  /** Sum of wait windows between steps (tool runs + later prefills). */
  waitMs: number;
  prefillMs: number | null;
  /** Whole-turn wall time including tool waits; null before start. */
  totalMs: number | null;
  /** Wall milliseconds the model spent blocked on the user this turn. */
  userWaitMs: number;
  /** True while an open user-wait interval is running. */
  waiting: boolean;
  tokPerSecDecode: number | null;
  /** Tokens per second over turn time minus user waits. */
  tokPerSecTurn: number | null;
  steps: number;
  /** Prompt tokens consumed across the turn's calls. */
  inputTokens: number;
  /** Cached prompt tokens across the turn's calls. */
  cachedTokens: number;
  /** Prompt tokens of the first step, for the prefill rate. */
  firstStepPromptTokens: number | null;
}

export function summarizeTurn(state: MeterState, charsPerToken: number, now: number): TurnSummary {
  const realOut = state.steps.reduce((sum, s) => sum + s.outTokens, 0);
  const inputTokens = state.steps.reduce((sum, s) => sum + s.inputTokens, 0);
  const cachedTokens = state.steps.reduce((sum, s) => sum + s.cachedTokens, 0);
  const waitMs = state.steps.reduce((sum, s) => sum + s.waitMs, 0);
  // Without any usage step there is no anchored window; the span of streamed
  // text stands in for it so estimate-only providers still get a decode rate.
  const decodeMs =
    state.steps.length > 0
      ? state.steps.reduce((sum, s) => sum + s.decodeMs, 0)
      : state.firstTextAt !== null && state.lastTextAt !== null
        ? Math.max(0, state.lastTextAt - state.firstTextAt)
        : 0;
  const hasReal = state.sawUsage && realOut > 0;
  const tailEst = state.liveChars / charsPerToken;
  const wholeEst = state.totalChars / charsPerToken;
  let outTokens: number | null = null;
  let estTokens: number;
  let approx: boolean;
  if (hasReal) {
    outTokens = realOut;
    estTokens = realOut + tailEst;
    approx = state.liveChars > 0;
  } else {
    estTokens = wholeEst;
    approx = true;
  }
  const prefillMs =
    state.firstTextAt !== null && state.startedAt !== null
      ? Math.max(0, state.firstTextAt - state.startedAt)
      : null;
  const end = state.endedAt ?? (state.phase === "running" ? now : null);
  const totalMs = state.startedAt !== null && end !== null ? Math.max(0, end - state.startedAt) : null;
  let userWaitMs = 0;
  for (const wait of state.userWaits) userWaitMs += Math.max(0, wait.end - wait.start);
  if (state.pausedAt !== null && end !== null) userWaitMs += Math.max(0, end - state.pausedAt);
  // The turn's productive time: wall clock minus the stretches where the
  // model was asleep waiting for the user.
  const activeMs = totalMs !== null ? Math.max(0, totalMs - userWaitMs) : null;
  const tokPerSecDecode =
    decodeMs > 0 && estTokens > 0 ? (outTokens ?? estTokens) / (decodeMs / 1000) : null;
  const tokPerSecTurn =
    activeMs !== null && activeMs > 0 && estTokens > 0 ? (outTokens ?? estTokens) / (activeMs / 1000) : null;
  return {
    outTokens,
    estTokens,
    approx,
    decodeMs,
    waitMs,
    prefillMs,
    totalMs,
    userWaitMs,
    waiting: state.pausedAt !== null && state.phase === "running",
    tokPerSecDecode,
    tokPerSecTurn,
    steps: state.steps.length,
    inputTokens,
    cachedTokens,
    firstStepPromptTokens: state.steps.length > 0 && state.steps[0].inputTokens > 0 ? state.steps[0].inputTokens : null,
  };
}

/** Blend a new chars/token measurement: EMA 0.7/0.3, clamped to CAL..CAL.
 * Small or nonsensical samples (mostly tool arguments, no visible text) are
 * rejected instead of poisoning the model's calibration. */
export function calibrate(
  prev: number | undefined,
  chars: number,
  tokens: number,
  minChars = CAL_MIN_CHARS,
): number | null {
  if (!(tokens > 0) || !(chars >= minChars)) return null;
  const observed = chars / tokens;
  if (!Number.isFinite(observed) || observed < 1) return null;
  const base = typeof prev === "number" && Number.isFinite(prev) ? prev : DEFAULT_CHARS_PER_TOKEN;
  const next = 0.7 * base + 0.3 * observed;
  return Math.min(CAL_MAX, Math.max(CAL_MIN, next));
}
