# turn-speed

A composer pill on every agent that shows how fast the model is decoding: live
tok/s while a turn runs, final tok/s and token totals after it, and a popover
with the breakdown — prefill/TTFT, in/out tokens, prompt cache hit rate,
model-call steps, tool wait time, and context occupancy.

Speed is measured over decode windows only: tool waits, long pauses, and prompt
prefill are separated out, so the number reflects generation speed rather than
turn latency. When the provider reports real usage (for OpenCode/MLX models
enable `options.includeUsage: true` in the provider config), numbers are exact.
Without usage the plugin estimates tokens from streamed characters, marks them
with `≈`, and auto-calibrates a per-model chars/token ratio from every step that
does report usage.

Options live under Settings → Plugins → Turn speed: what the pill leads with
(live estimate, decode-window average, or whole-turn rate, switchable from the
popover), smoothing window for the live number, token format, whether the pill
carries the cache hit rate, idle-pill visibility, and a manual chars/token
override. Requires Paseo 0.11 or later.
Turns are observed live; history from before a plugin reload is not
reconstructed, and subagents get their own pills instead of parent totals.
