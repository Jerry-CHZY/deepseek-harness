/**
 * The `tokenPricing` session-projection unit: the deployment's token price
 * table and currency symbol, projected to the browser so the composer readout
 * can price durable usage.
 *
 * Browser plugin rows carry no `config`, so a host-side projection is the
 * delivery path for a client-side readout's pricing. The unit is a constant:
 * it ignores every event, returns the same state reference, and therefore
 * publishes one value per session.
 *
 * @module @deepseek-ai/dsh-client-ui-token-usage/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ModelPrice, PricingProjection } from './pricing.ts'

const modelPriceSchema = z.object({
  inputMiss: z.number().min(0),
  inputHit: z.number().min(0),
  output: z.number().min(0),
}).strict()

const pricingSchema: z.ZodType<PricingProjection> = z.object({
  prices: z.record(z.string(), modelPriceSchema),
  currencySymbol: z.string(),
}).strict()

/**
 * Build the pricing projection unit for one resolved deployment table.
 * @param pricing - prices keyed by model-id prefix.
 * @param currencySymbol - symbol prefixed to the readout's cost figure.
 * @returns the unit definition the host registers on `ctx.sessionProjections`.
 */
export function createPricingProjectionDefinition(
  pricing: Readonly<Record<string, ModelPrice>>,
  currencySymbol: string,
) : Omit<ProjectionDefinition<'tokenPricing', PricingProjection>, 'wire'> & {
  /** This unit always wires a browser view, so registration may rely on it. */
  wire: { viewSchema: z.ZodType<PricingProjection>; view: (state: PricingProjection) => PricingProjection }
} {
  const value: PricingProjection = { prices: pricing, currencySymbol }
  return {
    key: 'tokenPricing',
    stateVersion: 1,
    stateSchema: pricingSchema,
    init: () => value,
    apply: state => state,
    wire: { viewSchema: pricingSchema, view: state => state },
  } satisfies ProjectionDefinition<'tokenPricing', PricingProjection>
}
