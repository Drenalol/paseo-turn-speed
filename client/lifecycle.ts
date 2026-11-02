/**
 * Turn-clock anchoring, shared by the two ways a turn can become known to the
 * plugin: a live `turn_started` stream event, or an agent snapshot taken when
 * the plugin attaches mid-turn.
 *
 * The instant must come from the observation itself, never from a cached
 * handle field. `ref()` snapshots update on the agent channel while turn
 * events arrive on the timeline channel, so reading `handle.activeTurn` right
 * after `turn_started` can still return the previous turn's start; the meter
 * would then charge the whole previous turn to this one (a 2s turn reported as
 * 63s, "whole turn" rate collapsing toward 0).
 */

export type TurnStartSource = "event" | "snapshot" | "arrival";

export interface TurnStart {
  /** Epoch milliseconds the meter should count from. */
  at: number;
  /** Where `at` came from; `arrival` means the timestamp was unusable. */
  source: TurnStartSource;
}

/** The daemon usually shares the app's clock; allow a little skew before
 * declaring a timestamp unreal. */
const MAX_CLOCK_SKEW_MS = 5_000;

/** A start event delivered later than this describes an older turn (a replay
 * or a long queue), not the one the pill is about to show. */
const MAX_EVENT_DELIVERY_LAG_MS = 60_000;

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Anchor a live `turn_started` to the daemon timestamp carried by the stream
 * message, clamped so the clock never starts in the future. */
export function turnStartFromEvent(
  timestamp: string | null | undefined,
  arrivedAt: number,
): TurnStart {
  const parsed = parseTimestamp(timestamp);
  if (parsed === null) return { at: arrivedAt, source: "arrival" };
  const lag = arrivedAt - parsed;
  if (lag < -MAX_CLOCK_SKEW_MS || lag > MAX_EVENT_DELIVERY_LAG_MS) {
    return { at: arrivedAt, source: "arrival" };
  }
  return { at: Math.min(parsed, arrivedAt), source: "event" };
}

/** Anchor a turn recovered from an agent snapshot read after the timeline
 * subscription is established. The snapshot's `startedAt` is the daemon's
 * accepted-turn boundary, so it is exact for a mid-turn attach. */
export function turnStartFromSnapshot(
  startedAt: string | null | undefined,
  observedAt: number,
): TurnStart {
  const parsed = parseTimestamp(startedAt);
  if (parsed === null) return { at: observedAt, source: "arrival" };
  if (parsed - observedAt > MAX_CLOCK_SKEW_MS) return { at: observedAt, source: "arrival" };
  return { at: Math.min(parsed, observedAt), source: "snapshot" };
}

/**
 * Terminal events are the only thing that closes a turn, and the timeline has
 * no replay: a terminal that falls into an uncovered window would leave the
 * pill running forever. The agent snapshot is the independent source of truth
 * for "this agent is no longer working", so an idle snapshot closes the turn
 * even when the stream event never arrived.
 *
 * A snapshot without a status is partial, not idle: never close on it.
 */
export function shouldCloseMissedTurn(
  phase: string,
  agentStatus: string | null | undefined,
): boolean {
  if (phase !== "running") return false;
  return typeof agentStatus === "string" && agentStatus !== "" && agentStatus !== "running";
}
