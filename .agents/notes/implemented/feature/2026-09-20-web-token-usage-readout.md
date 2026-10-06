# Agent Note: Web token-usage readout

Status: implemented

English | [中文](2026-09-20-web-token-usage-readout.zh.md)

## Problem

The Web GUI's composer statistics row reports a conversation's token usage as one total-token pill with a cache-hit share; the four disjoint billing buckets exist only behind that pill's dialog, so a reader who wants the classification has to click for it. The harness has no money figure anywhere, while the terminal front end already shows its own session cost estimate in its footer. A Web reader who wants "what did this conversation cost, and what was it made of" has neither in one place.

## Decision

**A separate, removable plugin.** `@deepseek-ai/dsh-client-ui-token-usage` is a pure UI plugin — its node half is an empty `apply()` so the row exists in the Loader, and its browser half registers one `conversation.composer.dock` entry (`id: 'token-usage'`, order 10, after the chat statistics pills). The web-app bundle mounts it by its own row, so removing that row removes the readout without touching `ui-chat`.

**Per-conversation counts come from the durable projection.** The entry reads `useProjection('tokenUsage')`, whose four buckets are disjoint and fold the complete durable log, so paging and compaction cannot change them; the slot's `scope: 'session'` is what makes the counters per-conversation. The line renders uncached input, output, and whichever cache buckets are non-zero, in compact counts (517 / 12.3K / 1.2M); zero cache buckets are dropped because they carry no information and only widen the row. The accessible label names all four buckets including the zero ones.

**Cost is a configured estimate, not a bill.** The entry resolves the session's `modelSelection` projection (preferring `lastUsed`, the route the billed usage came from, over `next`) against the plugin's `pricing` config: CNY per million tokens keyed by model-id prefix, longest matching prefix winning. The estimate bills uncached input plus cache writes at the miss rate, cache reads at the hit rate, and output at the output rate. An unpriced model shows counts with no cost figure rather than a guessed one, and sub-fen amounts keep micro-precision instead of rounding to zero. Defaults are the advisory DeepSeek official peak-rate table; deployments override them through the row config.

**Pricing reaches the browser through a host-registered projection.** The plugin's node half registers the configured table as the `tokenPricing` session projection; the browser component reads it with `useProjection('tokenPricing')`. Browser plugin rows carry no `config`, so a client-half `Config` would be defaults-only and the row's `config:` block would silently do nothing; the projection seam is the existing delivery path for host-owned values the browser renders, and it keeps the host row's `config:` authoritative.

## Alternatives considered

**Extending `ui-chat`'s `UsagePill`.** The pill already owns the durable total and the cache-hit share, and its dialog already lists the four buckets. Adding cost there would couple a user-facing pricing table to the chat package and keep the classification click-only; the request was an independently mountable readout, and a second dock row leaves the existing pill's reading intact.

**A host-side `tokenCost` projection.** A host fold could price each usage sample with the route that produced it and bucket it by the event's peak/off-peak hour, which the client cannot do from aggregate buckets. It would have to duplicate `dsh-token-meter`'s attempt-replacement and retry fold, and pricing is not a host-owned seam: no package publishes token prices. Deferred until a pricing seam exists.

**Merging the readout into the chat statistics row.** Composing two packages' content into one entry needs a runtime value dependency between feature plugins, which the client export discipline forbids; slots are the crossing point, and a sibling entry is the sanctioned form.

## Consequences

The classification is exact for the whole durable log, and the cost figure is as good as the configured table: one rate prices the conversation because the projection carries no per-sample timestamps, and one route prices it because `modelSelection.lastUsed` is the newest consumed route. Both limits are stated in the package README. The readout repeats the pill's total tokens in classified form; that duplication is the point of the request, and the pill remains the exact-integer surface. `pnpm --filter @deepseek-ai/dsh-client-ui-token-usage test` covers the pricing arithmetic (longest-prefix resolution, the miss/hit/output formula, the unlisted-model rule), the rendered classification and cost presence rules (including an absent `tokenPricing` projection), the host projection unit and its registration, and the browser half's registration, dictionary pairing, and fiber-teardown disposal.
