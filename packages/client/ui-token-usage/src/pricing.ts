/**
 * Cost estimation for one conversation's durable token usage.
 *
 * The estimate converts the `tokenUsage` projection's four disjoint billing
 * buckets into money with a deployment-supplied price table. It is a
 * reference figure, not a bill: prices change, peak/off-peak rates exist, and
 * the provider's own statement is authoritative.
 *
 * The table reaches the browser as the `tokenPricing` session projection
 * because browser plugin rows carry no `config`; the host half registers the
 * configured table and every session projects the same deployment constant.
 * The module also owns the `tokenCostBackfill` projection's value — the
 * browser notice's view of which routes the backfill price table missed.
 *
 * @module @deepseek-ai/dsh-client-ui-token-usage/pricing
 */

import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Price of one model route in CNY per million tokens. */
export interface ModelPrice {
  /** Prompt tokens that miss the cache (and cache-write tokens). */
  inputMiss: number
  /** Prompt tokens served from the cache. */
  inputHit: number
  /** Completion tokens, reasoning included. */
  output: number
}

/** Deployment price table and currency delivered to the browser through `tokenPricing`. */
export interface PricingProjection {
  /** Prices keyed by model-id prefix. */
  readonly prices: Readonly<Record<string, ModelPrice>>
  /** Symbol prefixed to the cost figure. */
  readonly currencySymbol: string
}

/** What the historical-cost backfill found for one session, read by the composer notice. */
export interface TokenCostBackfillProjection {
  /** Whether the session used at least one route the backfill price table prices. */
  readonly hasPricedUsage: boolean
  /** Routes (`provider/model`) the price table does not cover, deduplicated in first-seen order. */
  readonly unpricedRoutes: readonly string[]
  /** Report path under the session working directory, or null when the header records none. */
  readonly filePath: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Deployment token price table for the composer readout's cost estimate. */
    tokenPricing: PricingProjection
    /** Historical-cost backfill coverage for the composer pricing notice. */
    tokenCostBackfill: TokenCostBackfillProjection
  }

  interface SessionProjectionStateMap {
    tokenPricing: PricingProjection
    tokenCostBackfill: TokenCostBackfillProjection
  }
}


/**
 * Advisory DeepSeek official price table (CNY per million tokens, peak rate;
 * off-peak official rates are half). Deployments override it through the
 * plugin's `pricing` config; an unlisted model shows no cost figure rather
 * than a guessed one.
 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'deepseek-flash': Object.freeze({ inputMiss: 2, inputHit: 0.04, output: 8 }),
  'deepseek-v4-flash': Object.freeze({ inputMiss: 3, inputHit: 0.1, output: 9 }),
  'deepseek-v4-flash-vision-exp': Object.freeze({ inputMiss: 3, inputHit: 0.1, output: 9 }),
  'deepseek-v4-pro': Object.freeze({ inputMiss: 9, inputHit: 0.3, output: 27 }),
})

/**
 * Resolve a model id against a price table by longest matching prefix.
 *
 * Prefixes, not exact ids, because adapters append route suffixes (vision,
 * dated snapshots) that share the base model's price. The value type is open
 * because the readout's per-token price and the backfill's peak/off-peak pairs
 * both key off the same prefix rule.
 * @param model - the session's last-used model id.
 * @param table - prices keyed by model-id prefix.
 * @returns the matched entry, or undefined when no prefix matches.
 */
export function priceForModel<T>(
  model: string,
  table: Readonly<Record<string, T>>,
): T | undefined {
  let best: T | undefined
  let bestLength = 0
  for (const [prefix, price] of Object.entries(table)) {
    if (prefix.length > bestLength && model.startsWith(prefix)) {
      best = price
      bestLength = prefix.length
    }
  }
  return best
}

/**
 * Estimate one conversation's cost in CNY.
 *
 * Prompt tokens that missed the cache (uncached input plus cache writes) bill
 * at the miss rate; cache-hit prompt tokens bill at the hit rate; completion
 * tokens bill at the output rate. The result is exact arithmetic over the
 * projected buckets — the estimate error is entirely the price table's.
 * @param usage - the session's four disjoint billing buckets.
 * @param price - the matched model price.
 * @returns estimated cost in CNY.
 */
export function estimateCostCny(usage: TokenUsageProjection, price: ModelPrice): number {
  const missInput = usage.uncachedInputTokens + usage.cacheWriteTokens
  const millionths = missInput * price.inputMiss
    + usage.cacheReadTokens * price.inputHit
    + usage.outputTokens * price.output
  return millionths / 1_000_000
}

/**
 * Total billed tokens across the projection's four disjoint buckets.
 * @param usage - the session's four disjoint billing buckets.
 * @returns prompt-side billed input plus output.
 */
export function billedTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
}
