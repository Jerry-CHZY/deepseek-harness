---
description: "Web token-usage readout: the composer-dock line classifying the current conversation's durable usage into four billing buckets and pricing them; for users and maintainers of session cost displays."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-token-usage

English | [中文](README.zh.md)

## Summary

This package renders one composer-dock line under the Web GUI's composer: the current conversation's token usage split into its four disjoint billing buckets — uncached input, cache read, cache write, and output — plus an estimated cost. The counts come from the durable `tokenUsage` projection, so paging and compaction cannot change them; the slot's session scope makes the readout per-conversation. Cost comes from the plugin's `pricing` config, matched against the session's last-used model, and stays hidden when that model has no configured price.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `@deepseek-ai/dsh-token-meter` and the Session Controller; the readout then appears under the composer whenever the conversation has billed at least one token. It renders nothing before the first billed step, drops zero cache buckets, and keeps long rows to compact counts (517 / 12.3K / 1.2M).

Configure prices through this plugin's row config. `pricing` maps a model-id prefix to CNY per million tokens, and the longest matching prefix wins, so dated or vision routes can share or override a base model's price:

```yaml
- id: ui-token-usage
  name: '@deepseek-ai/dsh-client-ui-token-usage'
  config:
    currencySymbol: '¥'
    pricing:
      deepseek-v4-pro: { inputMiss: 9, inputHit: 0.3, output: 27 }
```

Defaults are the advisory DeepSeek official table (peak rates). A model absent from the resolved table shows its token counts without a cost figure, never a guessed one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers one entry on `conversation.composer.dock` (`id: 'token-usage'`, after the chat stats pills). It reads only framework hooks: `useProjection('tokenUsage')` for the four buckets and `useProjection('modelSelection')` for the route that produced them, preferring `lastUsed` over `next` because the last used route is the one the billed usage came from. The plugin owns no state, issues no RPC, and adds no model-visible content.

The cost estimate bills uncached input plus cache writes at the miss rate, cache reads at the hit rate, and output at the output rate: `((uncached + cacheWrite) * inputMiss + cacheRead * inputHit + output * output) / 1e6`. Sub-fen amounts keep micro-precision rather than rounding to zero. The host half registers the configured table as the `tokenPricing` session projection, because browser plugin rows carry no `config`; the browser component reads it with `useProjection('tokenPricing')` alongside `tokenUsage` and `modelSelection`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the readout's numbers are not enough. They own the measurement and the composer surface it sits in.

- [dsh-token-meter](../../llm/token-meter/README.md) — the `tokenUsage` and `contextPressure` projections this package reads.
- [ui-chat](../ui-chat/README.md) — the composer statistics pills, including the total-token dialog this line complements.
- [Session Controller](../../api/session-controller/README.md) — owns the `modelSelection` projection and the projection read seat.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser renders already-logged session projections for a human and registers nothing model-facing.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how accurate the readout can be, not a billing-grade cost feature.

- **The cost is an estimate, not a bill** — provider prices change, and the provider's own statement is authoritative. Default prices are advisory and deployments override them through config.
- **Peak and off-peak rates are not separated** — the projection carries no per-sample timestamps, so one rate prices the whole conversation. A table filled with peak rates overstates off-peak usage by up to the provider's peak discount.
- **One route prices a multi-model conversation** — `modelSelection.lastUsed` is the newest consumed route, so a conversation that switched models between priced routes prices all tokens at the last one. A route-aware cost projection is deferred until pricing becomes a host-owned seam.
- **Counts are compact, not exact** — the line rounds above 1,000 tokens; the chat statistics pill's dialog remains the exact-integer surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package is a read-only projection of two durable session projections onto one composer-dock entry; it emits no Cordis events, owns no cross-plugin mutable state, and its single slot registration proves disposal through the HMR-safety spec.
