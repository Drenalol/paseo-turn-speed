import type { PluginButton, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { approx, fmtDuration, fmtRate, fmtTokens } from "./format";
import type { AgentSpeedStore } from "./store";
import type { Preferences } from "../shared/preferences";

const PILL_REFRESH_MS = 500;

export interface PillView {
  label: string;
  icon: string;
  visible: boolean;
  title: string;
}

/** Number the pill leads with, per the numerator preference. */
function headlineTokPerSec(store: AgentSpeedStore, prefs: Preferences, now: number): number | null {
  const running = store.isRunning();
  if (running) {
    const live = store.liveTokPerSec(prefs.liveWindowSec);
    if (live !== null) return live;
  }
  const summary = store.summary(now);
  if (prefs.numerator === "turn") return summary.tokPerSecTurn ?? summary.tokPerSecDecode;
  return summary.tokPerSecDecode ?? summary.tokPerSecTurn;
}

export function computePillView(store: AgentSpeedStore, prefs: Preferences, now: number): PillView {
  const state = store.state;
  const phase = state.phase;
  if (phase === "idle") {
    return {
      label: "\u2014 tok/s",
      icon: "Gauge",
      visible: prefs.showIdlePills,
      title: "Turn speed",
    };
  }
  const summary = store.summary(now);
  const rate = headlineTokPerSec(store, prefs, now);
  const isApprox = summary.approx;
  const rateText = rate === null ? "\u2014" : `${approx(fmtRate(rate), isApprox)} tok/s`;
  const running = phase === "running";
  const waiting = summary.waiting;
  // The composer track is narrow: the pill carries the decode rate only, and
  // the turn state (live vs waiting) is shown solely by the leading icon.
  // Tokens, prefill and wait time live in the popover; the full picture goes
  // into the accessible title.
  const labelParts: string[] = [rateText];
  if (phase === "failed") labelParts.push("\u00b7 failed");
  if (phase === "canceled") labelParts.push("\u00b7 canceled");
  const titleParts = [`Turn speed ${rateText} decode`];
  if (waiting) titleParts.push("waiting for you");
  if (summary.estTokens > 0) {
    titleParts.push(`${approx(fmtTokens(summary.estTokens, prefs.tokenFormat), isApprox)} tok`);
  }
  if (summary.prefillMs !== null) titleParts.push(`TTFT ${fmtDuration(summary.prefillMs)}`);
  return {
    label: labelParts.join(" "),
    icon: waiting ? "Pause" : running ? "Zap" : "Activity",
    visible: true,
    title: titleParts.join(" \u00b7 "),
  };
}

export interface PillRegistrationHandle {
  destroy(): void;
}

/**
 * Registers a composer pill for one agent and keeps its label fresh: redraws
 * on store changes (throttled) and on a slow timer so the live number keeps
 * moving between events.
 */
export function bindPill(
  register: (button: PluginButton) => PluginButtonRegistration,
  buttonBase: Omit<PluginButton, "label" | "icon" | "visible" | "title">,
  store: AgentSpeedStore,
  getPrefs: () => Preferences,
  now: () => number,
): PillRegistrationHandle {
  const first = computePillView(store, getPrefs(), now());
  let registration = register({ ...buttonBase, ...first });
  let lastPaint = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const paint = (force: boolean) => {
    const t = now();
    if (!force && t - lastPaint < PILL_REFRESH_MS) {
      if (pendingTimer === null) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          paint(true);
        }, PILL_REFRESH_MS);
      }
      return;
    }
    lastPaint = t;
    const view = computePillView(store, getPrefs(), t);
    registration.update({ label: view.label, icon: view.icon, visible: view.visible, title: view.title });
  };

  const unsubscribe = store.subscribe(() => paint(false));
  // A slow heartbeat keeps the live tok/s and elapsed time honest while the
  // agent streams but the reducer has not changed on a given tick.
  const heartbeat = setInterval(() => paint(false), PILL_REFRESH_MS);
  paint(true);

  return {
    destroy() {
      unsubscribe();
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      clearInterval(heartbeat);
      registration.remove();
    },
  };
}
