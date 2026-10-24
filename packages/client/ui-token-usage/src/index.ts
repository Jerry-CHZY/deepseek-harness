/**
 * Token-usage readout plugin, node half: registers the deployment's
 * `tokenPricing` session projection so the browser readout can price durable
 * usage, plus the `tokenCostBackfill` projection and the one-time history
 * backfill that writes a `TOKEN_COST.md` per session working directory. It also
 * registers the `/usage` command, which answers from session state without a
 * provider request or a usage settlement. The plugin owns no session state.
 *
 * @module @deepseek-ai/dsh-client-ui-token-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_BACKFILL_PRICING,
  DEFAULT_PEAK_HOURS,
  runCostBackfill,
  type BackfillPrice,
  type PeakWindow,
  type PricePair,
} from './backfill.ts'
import { DEFAULT_PRICING, type ModelPrice } from './pricing.ts'
import { DEFAULT_REPORT_LABELS, installUsageCommand, registerUsageCommand, type UsageReportLabels } from './command.ts'
import { createBackfillProjectionDefinition, createPricingProjectionDefinition } from './projection.ts'

export type { BackfillPrice, PeakWindow, PricePair } from './backfill.ts'
export type { ModelPrice, PricingProjection, TokenCostBackfillProjection } from './pricing.ts'

/** First-install history backfill of the archived session corpus. */
export interface BackfillConfig {
  /**
   * Whether the plugin backfills archived sessions and publishes backfill
   * coverage. `false` leaves the browser notice unregistered too.
   * @default true
   */
  enabled?: boolean
  /**
   * Prices in CNY per million tokens, keyed by model-id prefix (the longest
   * matching prefix wins). Each pair is `[offPeak, peak]`. Defaults to the
   * advisory DeepSeek table, whose off-peak column is half its peak column; a
   * route absent from the table is reported as needing a price.
   */
  pricing?: Record<string, BackfillPrice>
  /**
   * Peak windows in Beijing time, replacing the defaults entirely. Defaults
   * are the weekday windows 09:00–12:00 and 14:00–18:00.
   */
  peakHours?: PeakWindow[]
}

/** The `/usage` command answered from session state instead of the provider. */
export interface CommandConfig {
  /**
   * Whether `/usage` is served at all: the registered command where the client
   * executes commands, and the model-boundary fallback where it can only send a
   * message. Neither calls the provider or settles usage, so it is on by default.
   * @default true
   */
  enabled?: boolean
  /**
   * Command name without the leading slash; the message fallback matches
   * `/<name>` exactly.
   * @default 'usage'
   */
  name?: string
  /** Copy for each figure; deployments that want another language override it. */
  labels?: Partial<UsageReportLabels>
}

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
  /** History backfill; the defaults run it against the advisory price table. */
  backfill?: BackfillConfig
  /** Local trigger line that answers with the readout without calling the provider. */
  command?: CommandConfig
}

/** `HH:MM` in 24-hour clock time. */
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/**
 * Schema for one `[offPeak, peak]` price pair.
 *
 * Schemastery widens tuple elements to optional, so the validated two-element
 * list is asserted back to the pair the config type declares; the runtime
 * requirement lives on the two element schemas.
 * @returns the pair schema.
 */
const pricePair = (): z<PricePair> =>
  z.tuple([z.number().min(0).required(), z.number().min(0).required()]).required() as unknown as z<PricePair>

const backfillSchema = z.object({
  enabled: z.boolean().default(true),
  pricing: z.dict(z.object({
    inputMiss: pricePair(),
    inputHit: pricePair(),
    output: pricePair(),
  })).default({ ...DEFAULT_BACKFILL_PRICING }),
  peakHours: z.array(z.object({
    days: z.array(z.number().min(0).max(6).required()).required(),
    start: z.string().pattern(CLOCK).required(),
    end: z.string().pattern(CLOCK).required(),
  })).default([...DEFAULT_PEAK_HOURS]),
})

const commandSchema = z.object({
  enabled: z.boolean().default(true),
  name: z.string().pattern(/^[a-z][a-z0-9_-]*$/u).default('usage'),
  labels: z.object({
    total: z.string().default(DEFAULT_REPORT_LABELS.total),
    input: z.string().default(DEFAULT_REPORT_LABELS.input),
    cacheRead: z.string().default(DEFAULT_REPORT_LABELS.cacheRead),
    cacheWrite: z.string().default(DEFAULT_REPORT_LABELS.cacheWrite),
    output: z.string().default(DEFAULT_REPORT_LABELS.output),
    context: z.string().default(DEFAULT_REPORT_LABELS.context),
  }).default({ ...DEFAULT_REPORT_LABELS }),
})

/** Validated readout configuration. */
export const Config: z<Config> = z.object({
  pricing: z.dict(z.object({
    inputMiss: z.number().min(0),
    inputHit: z.number().min(0),
    output: z.number().min(0),
  })).default({ ...DEFAULT_PRICING }),
  currencySymbol: z.string().default('¥'),
  backfill: backfillSchema,
  command: commandSchema,
})

/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections', 'sessions']

/**
 * Register the deployment pricing table and, unless disabled, the backfill
 * coverage projection plus the one-pass history backfill. Both registrations
 * are effects on this plugin's fiber, so unloading removes the keys for every
 * session; the backfill's own effect owns an abort controller that cancels the
 * pass on unload, and a pass failure is logged rather than propagated.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - validated plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.sessionProjections.register(createPricingProjectionDefinition(
    config.pricing ?? DEFAULT_PRICING,
    config.currencySymbol ?? '¥',
  ))
  const command: CommandConfig = config.command ?? {}
  if (command.enabled !== false) {
    const name = command.name ?? 'usage'
    const labels = { ...DEFAULT_REPORT_LABELS, ...command.labels }
    registerUsageCommand(ctx, { name, labels })
    installUsageCommand(ctx, { trigger: `/${name}`, labels })
  }
  const backfill: BackfillConfig = config.backfill ?? {}
  if (backfill.enabled === false) return
  const pricing = backfill.pricing ?? DEFAULT_BACKFILL_PRICING
  ctx.sessionProjections.register(createBackfillProjectionDefinition(pricing))
  const peakHours = backfill.peakHours ?? DEFAULT_PEAK_HOURS
  ctx.effect(() => {
    const controller = new AbortController()
    void runCostBackfill(ctx, { pricing, peakHours }, controller.signal).catch((error: unknown) => {
      ctx.logger.warn(`ui-token-usage: the TOKEN_COST.md backfill failed: ${String(error)}`)
    })
    return () => { controller.abort() }
  }, 'ui-token-usage: TOKEN_COST.md backfill')
}
