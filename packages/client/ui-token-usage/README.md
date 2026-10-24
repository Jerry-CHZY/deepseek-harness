---
description: "Web token-usage readout: the composer-dock line classifying the current conversation's durable usage into four billing buckets and pricing them; for users and maintainers of session cost displays."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-token-usage

English | [中文](README.zh.md)

## Summary

This package renders one composer-dock line under the Web GUI's composer: the current conversation's token usage split into its four disjoint billing buckets — uncached input, cache read, cache write, and output — plus an estimated cost. The counts come from the durable `tokenUsage` projection, so paging and compaction cannot change them; the slot's session scope makes the readout per-conversation. Cost comes from the plugin's `pricing` config, matched against the session's last-used model, and stays hidden when that model has no configured price. The host half also backfills the money Web never showed: one pass over the archived corpus writes a `TOKEN_COST.md` per session working directory, and the readout points at it when a route has no price.

## `/usage` quick start

Send `/usage` in any conversation. Where the client executes commands (the `dsh` CLI, the Web composer) it runs as a registered command; where it can only send a message (a phone client, a remote page, an APP page) the node half answers at the model boundary. Either way the provider is never called, no usage is settled, and the context occupancy reading keeps its value.

```text
合计 264M · 输入 2.6M · 缓存读 261M · 输出 608K · ≈¥20.40 · 上下文 440K/1M
```

Rename the command and localize its copy through the row config:

```yaml
- id: ui-token-usage
  name: '@deepseek-ai/dsh-client-ui-token-usage'
  config:
    command:
      name: usage
      labels:
        total: 合计
        input: 输入
        cacheRead: 缓存读
        cacheWrite: 缓存写
        output: 输出
        context: 上下文
```

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

Mount this plugin alongside `@deepseek-ai/dsh-token-meter` and the Session Controller; the readout then appears under the composer whenever the conversation has billed at least one token. The line starts with the session total, continues with the non-zero bucket split and the estimated cost, and ends with the context occupancy once the meter reports both a numerator and a route capacity. It renders nothing before the first billed step, drops zero cache buckets, and keeps long rows to compact counts (517 / 12.3K / 1.2M).

### Install into a profile

A profile installs this package as a direct dependency, which is what the Web GUI's installed-plugin list shows and toggles:

```powershell
node packages/client/ui-token-usage/scripts/pack-local.mjs
dsh plugin --profile <name> add <the .tgz path the script prints>
```

The script stages a copy whose manifest rewrites every `workspace:` range to the workspace version and drops `devDependencies`, because a workspace `pnpm pack` leaves `workspace:` in `devDependencies` and a profile install then fails with `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`. The package declares `dsh.bundle.patch`, so the profile mounts the readout row from the package's own `cordis.patch.yml` without a manual insert. The `desktop` profile belongs to the Electron application and rejects `dsh plugin` by design; install there through the application's own plugin surface.

The published build installs from npm directly, without packing anything:

```powershell
dsh plugin --profile web add @jerry_chzy/dsh-token-usage@0.1.1 --registry=https://registry.npmjs.org
```

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

### History backfill

The host half also walks the archived session corpus and writes a `TOKEN_COST.md` into each session's own working directory: one row per conversation recorded there, with its four billing buckets, its peak and off-peak amounts, and its total. `backfill.pricing` prices it with `[off-peak, peak]` pairs per million tokens, and `backfill.peakHours` replaces the Beijing-time peak windows (default: weekdays 09:00–12:00 and 14:00–18:00). `backfill.enabled: false` turns both the pass and its browser notice off.

```yaml
- id: ui-token-usage
  name: '@deepseek-ai/dsh-client-ui-token-usage'
  config:
    backfill:
      pricing:
        deepseek-v4-pro:
          inputMiss: [4.5, 9]
          inputHit: [0.15, 0.3]
          output: [13.5, 27]
```

Where no recorded route is priced, that same file instead lists the routes the table misses and the YAML row that would price them, and the composer readout gains a notice pointing at the file. The pass runs once per process start and skips a directory whose marker comment already carries the current fold version, price table, and every folded session watermark, so a restart rewrites nothing; a session that records no working directory is skipped rather than written to a guessed path.

### The `/usage` command

`/usage` reports the session's four buckets, the estimated cost, and the context occupancy without calling the provider. It reaches every client through two surfaces:

- **Clients that execute commands** (the `dsh` CLI, the Web composer) run the registered command: no model message is created and nothing is settled.
- **Clients that can only send a message** (a phone client, a remote page that relays session messages) reach the model boundary, where the node half answers with a stream that reports no usage. The provider is never called, and because no settlement is written the context occupancy reading keeps its value.

```yaml
- id: ui-token-usage
  name: '@deepseek-ai/dsh-client-ui-token-usage'
  config:
    command:
      name: usage
      labels:
        total: 合计
        input: 输入
        cacheRead: 缓存读
        cacheWrite: 缓存写
        output: 输出
        context: 上下文
```

The message fallback matches a whole text block of the newest human message; the harness's instruction, context, and skill-catalog messages carry other source kinds and never match. A session whose `tokenUsage` projection is unavailable falls through to the model, and the command reports a short diagnostic instead of guessing. `command.enabled: false` removes both surfaces, and `command.name` renames both the command and its `/name` trigger.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers one entry on `conversation.composer.dock` (`id: 'token-usage'`, after the chat stats pills). It reads only framework hooks: `useProjection('tokenUsage')` for the four buckets, `useProjection('modelSelection')` for the route that produced them (preferring `lastUsed` over `next` because the last used route is the one the billed usage came from), and `useProjection('contextPressure')` for the occupancy cell, where `projectedTokens` wins over `pressureTokens` exactly as the conversation meter reads it. The plugin owns no state, issues no RPC, and adds no model-visible content.

The cost estimate bills uncached input plus cache writes at the miss rate, cache reads at the hit rate, and output at the output rate: `((uncached + cacheWrite) * inputMiss + cacheRead * inputHit + output * output) / 1e6`. Sub-fen amounts keep micro-precision rather than rounding to zero. The host half registers the configured table as the `tokenPricing` session projection, because browser plugin rows carry no `config`; the browser component reads it with `useProjection('tokenPricing')` alongside `tokenUsage` and `modelSelection`.

The host half also registers `tokenCostBackfill`: a fold over `request/header` events that reports whether the session used a priced route, which routes the price table misses, and the report path derived from the session header's working directory. The component reads it with `useProjection('tokenCostBackfill')` and renders a locale-owned notice under the readout whenever a route is unpriced. The backfill itself is a separate effect on the plugin's fiber: it resolves `ctx.sessionQuery` optionally, reads each archived log through `readSession`, and writes with a temporary file plus a rename. It folds peak and off-peak usage per settlement — an `assistant/message` or a failed `assistant/attempt`, whose usage arrives either in the event's own field or as the last `usage` chunk of its embedded stream. Within one turn and step a later settlement replaces the earlier one, except that `llm/retry-started` closes that replacement slot, so the attempt after a retry adds to the one it followed.

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

The message fallback is the package's only model-visible output: one assistant message assembled from already-logged projections, carrying no usage sample and never sent to a provider. The command surface and the browser readout stay outside model history.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how accurate the readout can be, not a billing-grade cost feature.

- **The cost is an estimate, not a bill** — provider prices change, and the provider's own statement is authoritative. Default prices are advisory and deployments override them through config.
- **Peak and off-peak rates are not separated** — the projection carries no per-sample timestamps, so one rate prices the whole conversation. A table filled with peak rates overstates off-peak usage by up to the provider's peak discount.
- **One route prices a multi-model conversation** — `modelSelection.lastUsed` is the newest consumed route, so a conversation that switched models between priced routes prices all tokens at the last one. A route-aware cost projection is deferred until pricing becomes a host-owned seam.
- **Counts are compact, not exact** — the line rounds above 1,000 tokens; the chat statistics pill's dialog remains the exact-integer surface.
- **The report is a snapshot** — both surfaces reflect the session state when they run, so a step still in flight is excluded and neither settles usage.
- **The backfill only counts usage the log records** — a settlement without a provider-reported `usage` contributes nothing, so `TOKEN_COST.md` can understate a conversation whose provider never reported one.
- **An unpriced route gets instructions, not an amount** — when no recorded route matches `backfill.pricing`, the report holds the routes that need a price and the YAML row to add, and the composer notice says so; nothing is guessed and no partial amount is written.
- **A session without a working directory is skipped** — the pass logs it and writes nothing, rather than falling back to the process working directory or the user's home.
- **The backfill splits peak and off-peak per settlement** — each usage sample is priced by its own event timestamp in Beijing time, which is what the single-rate readout above cannot do.
- **Every start re-reads the archived corpus** — the pass folds the stored logs itself instead of reusing a projection cache, so its read cost grows linearly with the archived session count; the marker saves the write, not the read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package is a read-only projection of two durable session projections onto one composer-dock entry; it emits no Cordis events, owns no cross-plugin mutable state, and its single slot registration proves disposal through the HMR-safety spec.
