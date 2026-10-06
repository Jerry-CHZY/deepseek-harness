/**
 * Token-usage readout plugin, node half: registers the deployment's
 * `tokenPricing` session projection so the browser readout can price durable
 * usage. The plugin owns no model-visible surface and no session state.
 *
 * @module @deepseek-ai/dsh-client-ui-token-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_PRICING, type ModelPrice } from './pricing.ts'
import { createPricingProjectionDefinition } from './projection.ts'

export type { ModelPrice, PricingProjection } from './pricing.ts'

/** Token-usage readout runtime configuration. */
export interface Config {
  /**
   * Prices in CNY per million tokens, keyed by model-id prefix (the longest
   * matching prefix wins). Defaults to the advisory DeepSeek official table;
   * a model absent from the table shows tokens without a cost figure.
   */
  pricing?: Record<string, ModelPrice>
  /** Symbol prefixed to the cost figure. */
  currencySymbol?: string
}

/** Validated readout configuration. */
export const Config: z<Config> = z.object({
  pricing: z.dict(z.object({
    inputMiss: z.number().min(0),
    inputHit: z.number().min(0),
    output: z.number().min(0),
  })).default({ ...DEFAULT_PRICING }),
  currencySymbol: z.string().default('¥'),
})

/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * Register the deployment pricing table; the registration is an effect on
 * this plugin's fiber, so unloading removes the key for every session.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - validated plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.sessionProjections.register(createPricingProjectionDefinition(
    config.pricing ?? DEFAULT_PRICING,
    config.currencySymbol ?? '¥',
  ))
}
