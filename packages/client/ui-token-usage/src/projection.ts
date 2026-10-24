/**
 * The `tokenPricing` and `tokenCostBackfill` session-projection units: the
 * deployment's token price table plus the coverage its history backfill has
 * over this session's routes, projected to the browser so the composer readout
 * can price durable usage and point at the routes it cannot price.
 *
 * Browser plugin rows carry no `config`, so a host-side projection is the
 * delivery path for a client-side readout's pricing. The pricing unit is a
 * constant: it ignores every event, returns the same state reference, and
 * therefore publishes one value per session. The backfill unit folds
 * `request/header` events into the set of routes the backfill price table
 * misses, and derives the report path from the session header's working
 * directory.
 *
 * @module @deepseek-ai/dsh-client-ui-token-usage/projection
 */

import { join } from 'node:path'
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { BACKFILL_FILE_NAME, type BackfillPrice } from './backfill.ts'
import { priceForModel, type ModelPrice, type PricingProjection, type TokenCostBackfillProjection } from './pricing.ts'

const modelPriceSchema = z.object({
  inputMiss: z.number().min(0),
  inputHit: z.number().min(0),
  output: z.number().min(0),
}).strict()

const pricingSchema: z.ZodType<PricingProjection> = z.object({
  prices: z.record(z.string(), modelPriceSchema),
  currencySymbol: z.string(),
}).strict()

const backfillSchema: z.ZodType<TokenCostBackfillProjection> = z.object({
  hasPricedUsage: z.boolean(),
  unpricedRoutes: z.array(z.string()),
  filePath: z.string().nullable(),
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

/**
 * Build the backfill-coverage projection unit for one resolved price table.
 *
 * Only `request/header` can introduce a route, so every other event returns the
 * same state reference and publishes nothing. The report path comes from the
 * session header rather than from the running process: a session created in
 * another directory must point at that directory's file, and a header without
 * a working directory points nowhere.
 * @param pricing - backfill prices keyed by model-id prefix.
 * @returns the unit definition the host registers on `ctx.sessionProjections`.
 */
export function createBackfillProjectionDefinition(
  pricing: Readonly<Record<string, BackfillPrice>>,
) : Omit<ProjectionDefinition<'tokenCostBackfill', TokenCostBackfillProjection>, 'wire'> & {
  /** This unit always wires a browser view, so registration may rely on it. */
  wire: {
    viewSchema: z.ZodType<TokenCostBackfillProjection>
    view: (state: TokenCostBackfillProjection) => TokenCostBackfillProjection
  }
} {
  return {
    key: 'tokenCostBackfill',
    stateVersion: 1,
    stateSchema: backfillSchema,
    init: header => ({
      hasPricedUsage: false,
      unpricedRoutes: [],
      filePath: header.cwd === undefined ? null : join(header.cwd, BACKFILL_FILE_NAME),
    }),
    apply: (state, event) => {
      if (event.type !== 'request/header') return state
      const { provider, model } = event.data.header.config
      if (priceForModel(model, pricing) !== undefined) {
        return state.hasPricedUsage ? state : { ...state, hasPricedUsage: true }
      }
      const route = `${provider}/${model}`
      if (state.unpricedRoutes.includes(route)) return state
      return { ...state, unpricedRoutes: [...state.unpricedRoutes, route] }
    },
    wire: { viewSchema: backfillSchema, view: state => state },
  } satisfies ProjectionDefinition<'tokenCostBackfill', TokenCostBackfillProjection>
}
