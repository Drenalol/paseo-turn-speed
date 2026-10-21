import type { PluginClientContext } from "@getpaseo/plugin/client";
import { settingsRpc } from "@getpaseo/plugin";
import { createAgentSpeedStore, type AgentSpeedStore } from "./client/store";
import { bindPill } from "./client/pill";
import { makeSpeedDetails } from "./client/details";
import { makeSettingsScreen } from "./client/settings";
import {
  DEFAULT_METER_STATE,
  DEFAULT_PREFERENCES,
  meterState,
  preferences,
  type MeterStateDoc,
  type Preferences,
} from "./shared/preferences";
import { DEFAULT_CHARS_PER_TOKEN } from "./client/meter";

// Structural type derivation keeps `@getpaseo/client` out of the client
// bundle: only types provided through the plugin context are used.
type AgentsApi = PluginClientContext["paseo"]["agents"];type AgentHandle = ReturnType<AgentsApi["ref"]>;
type TimelineEvent = Parameters<Parameters<AgentHandle["timeline"]["subscribe"]>[0]>[0];
type StreamEvent = TimelineEvent["event"];
type AgentUpdate = Parameters<Parameters<AgentHandle["subscribe"]>[0]>[0];
type AgentSnapshot = Extract<AgentUpdate, { kind: "upsert" }>["agent"];
type AgentListResult = Awaited<ReturnType<AgentsApi["list"]>>;
type AgentEntry = AgentListResult["entries"][number];

interface Attachment {
  store: AgentSpeedStore;
  detach(): void;
}

const CAL_FLUSH_MS = 2000;

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const attached = new Map<string, Attachment>();
  const calibration = new Map<string, number>();
  const pendingCalibration = new Map<string, number>();
  let prefs: Preferences = DEFAULT_PREFERENCES;
  let calFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let listSubscription: { release(): Promise<void> } | null = null;

  const aborted = () => lifetime.signal.aborted;
  const logError = (...args: unknown[]) => {
    if (!aborted()) console.error("turn-speed:", ...args);
  };

  const effectiveCpt = (model: string | null): number => {
    if (prefs.manualCharsPerToken !== null) return prefs.manualCharsPerToken;
    if (model) {
      const learned = calibration.get(model);
      if (learned !== undefined) return learned;
    }
    return DEFAULT_CHARS_PER_TOKEN;
  };

  const refreshPrefs = async (): Promise<void> => {
    try {
      const read = await client.rpc(settingsRpc(preferences.id).read, {});
      if (read.status === "ready") {
        const parsed = preferences.schema.safeParse(read.values);
        if (parsed.success) prefs = parsed.data;
      }
    } catch (error) {
      logError("reading preferences failed", error);
    }
  };

  const refreshCalibration = async (): Promise<void> => {
    try {
      const read = await client.rpc(settingsRpc(meterState.id).read, {});
      if (read.status === "ready") {
        const parsed = meterState.schema.safeParse(read.values);
        if (parsed.success) {
          calibration.clear();
          for (const [model, cpt] of Object.entries(parsed.data.calibration)) {
            calibration.set(model, cpt);
          }
        }
      }
    } catch (error) {
      logError("reading calibration failed", error);
    }
  };

  /** Read-modify-write a settings document; one retry on revision conflict. */
  const mutateDoc = async (
    def: typeof meterState,
    mutate: (values: MeterStateDoc) => MeterStateDoc,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const read = await client.rpc(settingsRpc(def.id).read, {});
        if (read.status !== "ready") return;
        const parsed = def.schema.safeParse(read.values);
        const current = parsed.success ? parsed.data : DEFAULT_METER_STATE;
        const next = mutate(current);
        const write = await client.rpc(settingsRpc(def.id).write, {
          revision: read.revision,
          values: JSON.parse(JSON.stringify(next)),
        });
        if (write.status === "saved") return;
        if (write.status !== "conflict") return;
      } catch (error) {
        logError("settings write failed", error);
        return;
      }
    }
  };

  const flushCalibration = (): void => {
    calFlushTimer = null;
    if (aborted() || pendingCalibration.size === 0) return;
    const batch = Object.fromEntries(pendingCalibration);
    pendingCalibration.clear();
    void mutateDoc(meterState, (doc) => ({
      calibration: { ...doc.calibration, ...batch },
    })).then(refreshPrefs);
  };

  const onCalibration = (model: string, charsPerToken: number): void => {
    calibration.set(model, charsPerToken);
    pendingCalibration.set(model, charsPerToken);
    if (calFlushTimer === null) calFlushTimer = setTimeout(flushCalibration, CAL_FLUSH_MS);
  };

  function mapUsage(usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    contextWindowMaxTokens?: number;
    contextWindowUsedTokens?: number;
  }) {
    return {
      input: usage.inputTokens,
      cached: usage.cachedInputTokens,
      output: usage.outputTokens,
      ctxMax: usage.contextWindowMaxTokens,
      ctxUsed: usage.contextWindowUsedTokens,
    };
  }

  function onStreamEvent(
    store: AgentSpeedStore,
    handle: AgentHandle,
    event: StreamEvent,
    reseed: () => void,
    waits: Set<string>,
  ): void {
    const at = Date.now();
    switch (event.type) {
      case "turn_started": {
        waits.clear();
        const startedAt = handle.activeTurn?.startedAt;
        const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
        store.dispatch({
          t: "turn_started",
          at: Number.isFinite(parsed) ? parsed : at,
          turnId: event.turnId ?? handle.activeTurn?.turnId ?? null,
        });
        break;
      }
      case "turn_completed":
        waits.clear();
        store.dispatch({
          t: "turn_ended",
          at,
          kind: "completed",
          usage: event.usage ? mapUsage(event.usage) : undefined,
          maxTokPerSec: prefs.maxPlausibleTokPerSec,
        });
        void refreshPrefs();
        break;
      case "turn_failed":
        waits.clear();
        store.dispatch({ t: "turn_ended", at, kind: "failed", note: event.error });
        break;
      case "turn_canceled":
        waits.clear();
        store.dispatch({ t: "turn_ended", at, kind: "canceled", note: event.reason });
        break;
      case "permission_requested":
      case "permission_resolved": {
        // Any request (question, tool approval, plan) means the model is
        // asleep until the user answers; pause the meter for the whole set
        // of open requests, not per request.
        if (event.type === "permission_requested") {
          const requestId = event.request?.id;
          if (!requestId) break;
          const wasIdle = waits.size === 0;
          waits.add(requestId);
          if (wasIdle) store.dispatch({ t: "user_wait_started", at });
        } else if (waits.delete(event.requestId) && waits.size === 0) {
          store.dispatch({ t: "user_wait_ended", at });
        }
        break;
      }
      case "timeline": {
        const item = event.item;
        if (item.type === "assistant_message") {
          store.dispatch({ t: "text", at, key: item.messageId ?? "assistant", text: item.text });
        } else if (item.type === "reasoning") {
          // Per-turn key: text tails survive turn boundaries, and each turn's
          // reasoning block starts fresh.
          store.dispatch({
            t: "text",
            at,
            key: `reasoning:${event.turnId ?? "current"}`,
            text: item.text,
          });
        } else if (item.type === "compaction") {
          store.dispatch({ t: "compaction", at });
        }
        break;
      }
      case "replacement":
      case "subscription_restored":
        // Do not replay history we never saw; the live window is local anyway.
        waits.clear();
        store.dispatch({ t: "reset" });
        // Provider counters kept moving while we were blind: re-read them so
        // the next delta is the new work, not the whole unseen gap.
        reseed();
        break;
      case "error":
        logError(`timeline subscription error for ${event.error}`);
        break;
      default:
        break;
    }
  }

  function attach(agent: AgentSnapshot): void {
    if (aborted() || attached.has(agent.id) || !agent.workspaceId) return;
    const workspaceId = agent.workspaceId;
    const handle = client.paseo.agents.ref(agent.id);
    const store = createAgentSpeedStore({
      agentId: agent.id,
      charsPerToken: (model) => effectiveCpt(model),
      learnedCharsPerToken: (model) => calibration.get(model),
      onCalibration,
      cacheCounting: () => prefs.cacheCounting,
      now: () => Date.now(),
    });
    store.setIdentity(agent.provider, agent.model ?? null);
    // The daemon folds provider usage into the agent snapshot: every model
    // call bumps `lastUsage` and pushes an agent_update. Track changes there.
    let lastUsageSig: string | null = null;
    const observeUsage = (usage: Parameters<typeof mapUsage>[0] | null): void => {
      if (!usage) return;
      const mapped = mapUsage(usage);
      const sig = [mapped.output, mapped.input, mapped.cached, mapped.ctxUsed, mapped.ctxMax]
        .map((v) => (v === undefined ? "" : String(v)))
        .join("|");
      if (sig === lastUsageSig) return;
      lastUsageSig = sig;
      store.dispatch({
        t: "usage",
        at: Date.now(),
        usage: mapped,
        maxTokPerSec: prefs.maxPlausibleTokPerSec,
      });
    };
    // Seed the cumulative baseline synchronously from the snapshot that
    // triggered the attach, then from the handle when it is populated.
    observeUsage(agent.lastUsage ?? null);
    observeUsage(handle.lastUsage);
    // Open permission/question requests: non-empty means the model is
    // blocked on the user and the meter must not charge that time to it.
    const pendingWaits = new Set<string>();
    const syncWaits = (snapshot: {
      pendingPermissions?: readonly { id: string }[] | null;
    }): void => {
      const pending = snapshot.pendingPermissions;
      if (!pending) return;
      pendingWaits.clear();
      for (const request of pending) pendingWaits.add(request.id);
      store.dispatch({
        t: pendingWaits.size > 0 ? "user_wait_started" : "user_wait_ended",
        at: Date.now(),
      });
    };
    syncWaits(agent);
    // Attaching mid-turn (agent created before the plugin loaded, or a fresh
    // agent whose turn_started raced the subscription): start the meter from
    // the snapshot so the pill exists for the rest of that turn.
    const seedTurn = (snapshot: {
      status?: string | null;
      activeTurn?: { turnId?: string | null; startedAt?: string | null } | null;
    }): void => {
      if (store.state.phase !== "idle" || snapshot.status !== "running" || !snapshot.activeTurn) return;
      const raw = snapshot.activeTurn.startedAt;
      const parsed = raw ? Date.parse(raw) : Number.NaN;
      store.dispatch({
        t: "turn_started",
        at: Number.isFinite(parsed) ? parsed : Date.now(),
        turnId: snapshot.activeTurn.turnId ?? null,
      });
    };
    seedTurn(agent);
    // A ref() handle starts empty: without a real snapshot, the first usage
    // event after a reload would count the session-cumulative counters as
    // one giant step. Fetch the truth for that case.
    const reseed = (): void => {
      void handle
        .refresh()
        .then((result) => {
          const snapshot = result?.agent;
          if (!snapshot || attached.get(agent.id)?.store !== store) return;
          store.setIdentity(snapshot.provider, snapshot.model ?? null);
          observeUsage(snapshot.lastUsage ?? null);
          syncWaits(snapshot);
          seedTurn(snapshot);
        })
        .catch((error) => logError(`usage reseed failed for ${agent.id}`, error));
    };
    reseed();

    const details = makeSpeedDetails(store, () => prefs, () => effectiveCpt(store.model), () => {
      void refreshPrefs();
    });
    let pillHandle: { destroy(): void } | null = null;
    try {
      pillHandle = bindPill(
        (button) =>
          client.addComposerPill({ id: "speed", workspaceId, agentId: agent.id, button }),
        {
          behavior: { kind: "popover", Content: details },
        },
        store,
        () => prefs,
        () => Date.now(),
      );
    } catch (error) {
      logError(`pill registration failed for agent ${agent.id}`, error);
    }

    const releaseAgentUpdates = handle.subscribe((update) => {
      if (update.kind === "remove") {
        detach(agent.id);
        return;
      }
      const snapshot = update.agent;
      store.setIdentity(snapshot.provider, snapshot.model ?? null);
      observeUsage(snapshot.lastUsage ?? null);
      syncWaits(snapshot);
      seedTurn(snapshot);
      if (snapshot.archivedAt || snapshot.status === "closed") detach(agent.id);
    });

    const timelineSub = handle.timeline.subscribe((event) => {
      try {
        onStreamEvent(store, handle, event.event, reseed, pendingWaits);
      } catch (error) {
        logError(`timeline event failed for ${agent.id}`, error);
      }
    });
    void timelineSub.ready.catch((error) => logError(`timeline subscribe failed for ${agent.id}`, error));

    attached.set(agent.id, {
      store,
      detach() {
        pillHandle?.destroy();
        releaseAgentUpdates();
        void timelineSub.release().catch(() => undefined);
      },
    });
  }

  function detach(agentId: string): void {
    const attachment = attached.get(agentId);
    if (!attachment) return;
    attached.delete(agentId);
    try {
      attachment.detach();
    } catch (error) {
      logError(`detach failed for ${agentId}`, error);
    }
  }

  function syncAgents(entries: readonly AgentEntry[]): void {
    for (const entry of entries) {
      const agent = entry.agent;
      if (agent.archivedAt || agent.status === "closed") detach(agent.id);
      else attach(agent);
    }
  }

  async function boot(): Promise<void> {
    try {
      await Promise.all([refreshPrefs(), refreshCalibration()]);
      if (aborted()) return;
      const list = await client.paseo.agents.list({
        subscribe: {},
        page: { limit: 200 },
        signal: lifetime.signal,
      });
      if (aborted()) {
        void list.subscription.release().catch(() => undefined);
        return;
      }
      listSubscription = list.subscription;
      const releaseObserver = list.subscription.subscribe({
        snapshot: (snapshot) => syncAgents(snapshot.entries),
        update: (message) => {
          if (message.type !== "agent_update") return;
          const payload = message.payload;
          if (payload.kind === "remove") {
            detach(payload.agentId);
            return;
          }
          const agent = payload.agent;
          if (agent.archivedAt || agent.status === "closed") detach(agent.id);
          else attach(agent);
        },
        error: (error) => logError("agent list subscription failed", error),
      });
      cleanups.push(releaseObserver);
      syncAgents(list.entries);
    } catch (error) {
      if (!aborted()) logError("bootstrap failed", error);
    }
  }

  const cleanups: Array<() => void> = [];
  cleanups.push(
    client.addSettingsScreen({
      id: "preferences",
      title: "Turn speed",
      icon: "Gauge",
      Component: makeSettingsScreen(() => void refreshPrefs()),
    }),
  );

  void boot();

  return () => {
    lifetime.abort();
    if (calFlushTimer !== null) {
      clearTimeout(calFlushTimer);
      calFlushTimer = null;
    }
    for (const agentId of [...attached.keys()]) detach(agentId);
    if (listSubscription) {
      void listSubscription.release().catch(() => undefined);
      listSubscription = null;
    }
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort teardown.
      }
    }
    cleanups.length = 0;
  };
}
