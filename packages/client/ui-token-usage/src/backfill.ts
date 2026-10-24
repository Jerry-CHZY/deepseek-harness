/**
 * First-install history backfill: fold every archived session's durable usage
 * into peak/off-peak money and write one `TOKEN_COST.md` per session working
 * directory.
 *
 * The pass is a side effect of the plugin's fiber, not of its activation: it
 * runs once per process start against the archived corpus, is idempotent
 * through a marker comment carrying the fold version, the config hash, and the
 * folded session watermarks, and never writes outside a session header's own
 * `cwd`. A deployment without `ctx.sessionQuery` mounted, or a session without
 * a working directory, is skipped with a log line rather than a guess.
 *
 * @module @deepseek-ai/dsh-client-ui-token-usage/backfill
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the provider usage record a settlement or its stream reports.
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
// Type-only: the `llm/retry-started` SessionEventMap key merge.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { priceForModel } from './pricing.ts'

/** Name of the report written into each session working directory. */
export const BACKFILL_FILE_NAME = 'TOKEN_COST.md'

/** Marker prefix the report's first line carries. */
const MARKER_PREFIX = '<!-- dsh-token-cost-backfill:'

/**
 * Fold-semantics version carried in the report marker.
 *
 * Increment it whenever {@link foldSessionUsage} can fold one log differently —
 * version 1 read only the `assistant/message` usage field and missed
 * stream-embedded usage and retried attempts. Without the bump a report written
 * under the old semantics keeps matching the marker, and its understated
 * amounts stay on disk forever.
 */
const FOLD_SEMANTICS_VERSION = 2

/** China Standard Time offset; peak windows are stated in Beijing time. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** One price pair as `[offPeak, peak]`, in CNY per million tokens. */
export type PricePair = readonly [offPeak: number, peak: number]

/** One model route's peak and off-peak prices, in CNY per million tokens. */
export interface BackfillPrice {
  /** Uncached prompt tokens, billed with cache-write tokens. */
  inputMiss: PricePair
  /** Prompt tokens served from the cache. */
  inputHit: PricePair
  /** Completion tokens, reasoning included. */
  output: PricePair
}

/** One peak-rate window in Beijing time. */
export interface PeakWindow {
  /** Weekdays the window covers, `0` = Sunday through `6` = Saturday. */
  days: number[]
  /** Inclusive `HH:MM` start. */
  start: string
  /** Exclusive `HH:MM` end. */
  end: string
}

/** Advisory peak windows: Beijing-time weekdays 09:00–12:00 and 14:00–18:00. */
export const DEFAULT_PEAK_HOURS: readonly PeakWindow[] = Object.freeze([
  { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
  { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
])

/** Build one price entry from its peak rates; off-peak is half. */
function peakPrice(inputMiss: number, inputHit: number, output: number): BackfillPrice {
  const pair = (peak: number): PricePair => Object.freeze([peak / 2, peak]) as PricePair
  return Object.freeze({ inputMiss: pair(inputMiss), inputHit: pair(inputHit), output: pair(output) })
}

/**
 * Advisory DeepSeek price table for the backfill (CNY per million tokens,
 * `[offPeak, peak]`). Deployments override it through `backfill.pricing`; a
 * route absent from the resolved table is reported as needing a price instead
 * of being guessed at.
 */
export const DEFAULT_BACKFILL_PRICING: Readonly<Record<string, BackfillPrice>> = Object.freeze({
  'deepseek-flash': peakPrice(2, 0.04, 8),
  'deepseek-v4-flash': peakPrice(3, 0.1, 9),
  'deepseek-v4-flash-vision-exp': peakPrice(3, 0.1, 9),
  'deepseek-v4-pro': peakPrice(9, 0.3, 27),
})

/** One archived session's durable usage, folded and split by rate period. */
export interface SessionCostSample {
  /** Session the usage was recorded under. */
  readonly sessionId: SessionId
  /** Every route (`provider/model`) the log records, in first-seen order. */
  readonly routes: readonly string[]
  /** Route in force at the log's last header event, or null when it has none. */
  readonly route: string | null
  /** Usage recorded inside a peak window. */
  readonly peak: TokenUsageProjection
  /** Usage recorded outside every peak window. */
  readonly offPeak: TokenUsageProjection
  /** Highest event seq folded. */
  readonly lastSeq: number
}

/** One backfill pass's resolved configuration. */
export interface BackfillRunOptions {
  /** Prices in CNY per million tokens, keyed by model-id prefix. */
  readonly pricing: Readonly<Record<string, BackfillPrice>>
  /** Peak windows in Beijing time. */
  readonly peakHours: readonly PeakWindow[]
}

/** The zero value of the four disjoint billing buckets. */
function zeroUsage(): TokenUsageProjection {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** Add one sample into a bucket total, mutating it. */
function addUsage(total: TokenUsageProjection, usage: TokenUsageProjection): void {
  total.uncachedInputTokens += usage.uncachedInputTokens
  total.outputTokens += usage.outputTokens
  total.cacheReadTokens += usage.cacheReadTokens
  total.cacheWriteTokens += usage.cacheWriteTokens
}

/** Remove one previously counted sample from a bucket total, mutating it. */
function removeUsage(total: TokenUsageProjection, usage: TokenUsageProjection): void {
  total.uncachedInputTokens -= usage.uncachedInputTokens
  total.outputTokens -= usage.outputTokens
  total.cacheReadTokens -= usage.cacheReadTokens
  total.cacheWriteTokens -= usage.cacheWriteTokens
}

/** `HH:MM` as minutes since local midnight. */
function toMinutes(value: string): number {
  const [hours, minutes] = value.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * Whether one instant falls inside a Beijing-time peak window.
 * @param time - event timestamp in Unix epoch milliseconds.
 * @param windows - peak windows stated in Beijing time.
 * @returns true when some window covers the instant's weekday and clock time.
 */
export function isPeakInstant(time: number, windows: readonly PeakWindow[]): boolean {
  const local = new Date(time + BEIJING_OFFSET_MS)
  const day = local.getUTCDay()
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  return windows.some(window => window.days.includes(day)
    && minutes >= toMinutes(window.start)
    && minutes < toMinutes(window.end))
}

/** One durable settlement event that can report provider usage. */
type SettlementEvent = Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }>

/**
 * The provider usage one durable settlement reports.
 *
 * An `assistant/message` may carry the usage verbatim. Every other settlement —
 * a failed `assistant/attempt`, or a message whose usage survived only inside
 * its stream — reports it as the last `usage` chunk of the embedded compact
 * record list, matching how the `tokenUsage` projection reads the same log.
 * @param event - the settlement event to read.
 * @returns the reported usage, or undefined when the settlement carries none.
 */
function reportedUsage(event: SettlementEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  let found: TokenUsage | undefined
  for (const record of event.data.stream) {
    if (record.type === 'chunk' && record.chunk.type === 'usage') found = record.chunk.usage
  }
  return found
}

/**
 * Fold one session log's durable usage into peak/off-peak buckets and routes.
 *
 * A settlement is either an `assistant/message` or a failed `assistant/attempt`;
 * both report usage, and a stream-embedded sample counts even when the event's
 * own `usage` field is absent. A second sample for the same turn and step
 * replaces the first instead of adding to it, matching the `tokenUsage`
 * projection: the provider reports one attempt's usage, and a re-settled
 * attempt must not bill twice. `llm/retry-started` closes that replacement slot,
 * so the sample after a retry adds to the failed attempt it followed — those
 * tokens were billed too. Each sample lands in the period its own event
 * timestamp falls in, so a conversation spanning the peak boundary is priced at
 * both rates.
 * @param sessionId - session the log belongs to.
 * @param events - the session's complete raw log, in seq order.
 * @param windows - peak windows stated in Beijing time.
 * @returns the folded routes, period buckets, and highest folded seq.
 */
export function foldSessionUsage(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  windows: readonly PeakWindow[],
): SessionCostSample {
  const peak = zeroUsage()
  const offPeak = zeroUsage()
  const routes: string[] = []
  const lastSeq = events.at(-1)?.seq ?? -1
  let route: string | null = null
  let slot: { turn: number; step: number; usage: TokenUsageProjection; peak: boolean } | undefined
  for (const event of events) {
    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      route = `${provider}/${model}`
      if (!routes.includes(route)) routes.push(route)
      continue
    }
    if (event.type === 'llm/retry-started') {
      if (slot !== undefined && slot.turn === event.data.turn && slot.step === event.data.step) slot = undefined
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = reportedUsage(event)
    if (usage === undefined) continue
    const buckets: TokenUsageProjection = {
      uncachedInputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    }
    const inPeak = isPeakInstant(event.time, windows)
    if (slot !== undefined && slot.turn === event.data.turn && slot.step === event.data.step) {
      removeUsage(slot.peak ? peak : offPeak, slot.usage)
    }
    addUsage(inPeak ? peak : offPeak, buckets)
    slot = { turn: event.data.turn, step: event.data.step, usage: buckets, peak: inPeak }
  }
  return { sessionId, routes, route, peak, offPeak, lastSeq }
}

/**
 * Price one period's four buckets with a route price.
 * @param usage - the period's four disjoint billing buckets.
 * @param price - the route's `[offPeak, peak]` price pairs.
 * @param peak - which period prices the usage.
 * @returns cost in CNY.
 */
function periodCostCny(usage: TokenUsageProjection, price: BackfillPrice, peak: boolean): number {
  const index = peak ? 1 : 0
  const millionths = (usage.uncachedInputTokens + usage.cacheWriteTokens) * price.inputMiss[index]
    + usage.cacheReadTokens * price.inputHit[index]
    + usage.outputTokens * price.output[index]
  return millionths / 1_000_000
}

/** Model id of a `provider/model` route; model ids never contain `/`. */
function modelOf(route: string): string {
  return route.slice(route.indexOf('/') + 1)
}

/** Resolve one session's price from its last recorded route. */
function priceOf(sample: SessionCostSample, table: Readonly<Record<string, BackfillPrice>>): BackfillPrice | undefined {
  return sample.route === null ? undefined : priceForModel(modelOf(sample.route), table)
}

/** Currency rendering that never rounds a real cost to a bare zero. */
function formatCny(value: number): string {
  if (value === 0) return '0'
  if (value < 0.01) return value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')
  if (value < 1) return value.toFixed(3)
  return value.toFixed(2)
}

/** Stable identity of one report: the fold semantics, the price table, and every folded watermark. */
function markerFor(samples: readonly SessionCostSample[], pricing: Readonly<Record<string, BackfillPrice>>): string {
  const configHash = createHash('sha256').update(JSON.stringify(pricing)).digest('hex').slice(0, 16)
  const watermarks = [...samples]
    .sort((left, right) => String(left.sessionId).localeCompare(String(right.sessionId)))
    .map(sample => `${sample.sessionId}:${sample.lastSeq}`)
    .join(',')
  return `${MARKER_PREFIX} fold=${FOLD_SEMANTICS_VERSION} config=${configHash} sessions=${watermarks} -->`
}

/** The routes across one working directory that need a price, with session counts. */
function unpricedRoutes(
  samples: readonly SessionCostSample[],
  pricing: Readonly<Record<string, BackfillPrice>>,
): [route: string, sessions: number][] {
  const counts = new Map<string, number>()
  for (const sample of samples) {
    for (const route of sample.routes) {
      if (priceForModel(modelOf(route), pricing) !== undefined) continue
      counts.set(route, (counts.get(route) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
}

/** Header paragraph shared by both report forms. */
function reportIntro(samples: readonly SessionCostSample[]): string {
  return `# TOKEN_COST.md\n\nHistorical cost backfill over ${samples.length} archived session(s) recorded in this working directory.`
}

/** Amounts table for a working directory that has at least one priced route. */
function renderAmounts(
  samples: readonly SessionCostSample[],
  pricing: Readonly<Record<string, BackfillPrice>>,
  generatedAt: string,
): string {
  const rows = samples.map((sample) => {
    const price = priceOf(sample, pricing)
    const peak = price === undefined ? undefined : periodCostCny(sample.peak, price, true)
    const offPeak = price === undefined ? undefined : periodCostCny(sample.offPeak, price, false)
    const model = sample.route === null ? '—' : `\`${sample.route}\``
    const money = (value: number | undefined): string =>
      value === undefined ? '—' : `¥${formatCny(value)}`
    const total = peak === undefined || offPeak === undefined ? undefined : peak + offPeak
    const buckets = zeroUsage()
    addUsage(buckets, sample.peak)
    addUsage(buckets, sample.offPeak)
    return `| \`${sample.sessionId}\` | ${model}`
      + ` | ${buckets.uncachedInputTokens} | ${buckets.cacheReadTokens} | ${buckets.cacheWriteTokens} | ${buckets.outputTokens}`
      + ` | ${money(peak)} | ${money(offPeak)} | ${money(total)} |`
  })
  return [
    reportIntro(samples),
    'Amounts are CNY per the configured rates and are split by each event\'s Beijing-time window; `—` marks a route with no configured price.',
    '',
    '| Session | Model | Input (miss) | Cache read | Cache write | Output | Peak cost | Off-peak cost | Total |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    `Generated ${generatedAt} by @deepseek-ai/dsh-client-ui-token-usage.`,
  ].join('\n')
}

/** Pricing instructions for a working directory whose routes are all unpriced. */
function renderInstructions(
  samples: readonly SessionCostSample[],
  pricing: Readonly<Record<string, BackfillPrice>>,
  generatedAt: string,
): string {
  const routes = unpricedRoutes(samples, pricing)
    .map(([route, sessions]) => `- \`${route}\` — ${sessions} session(s)`)
  return [
    reportIntro(samples),
    'No configured price matched the recorded model route(s), so no amount could be computed.',
    '',
    'Routes without a price:',
    '',
    ...routes,
    '',
    'Add one by pasting this row into `~/.dsh/profiles/web/cordis.patch.yml` and restarting Web.',
    'Each pair is `[off-peak, peak]` in CNY per million tokens; the longest matching model-id prefix wins.',
    '',
    '```yaml',
    '- id: ui-token-usage',
    "  name: '@deepseek-ai/dsh-client-ui-token-usage'",
    '  config:',
    '    backfill:',
    '      pricing:',
    '        <model-id-prefix>:',
    '          inputMiss: [4.5, 9]',
    '          inputHit: [0.15, 0.3]',
    '          output: [13.5, 27]',
    '```',
    '',
    'The next start rewrites this file with the amounts.',
    '',
    `Generated ${generatedAt} by @deepseek-ai/dsh-client-ui-token-usage.`,
  ].join('\n')
}

/**
 * Write one working directory's report, unless its marker already matches.
 *
 * The write is a temporary file plus a rename, so a reader never observes a
 * half-written report and a crash leaves the previous one intact. The marker
 * carries the fold version, the price-table hash, and every folded watermark,
 * so a pass skips work only when the folding semantics, the configuration, and
 * the archived usage all still match.
 * @param cwd - the session working directory the report belongs to.
 * @param samples - the directory's folded sessions.
 * @param options - the resolved backfill configuration.
 */
async function writeReport(
  cwd: string,
  samples: readonly SessionCostSample[],
  options: BackfillRunOptions,
): Promise<void> {
  if (samples.every(sample => sample.routes.length === 0)) return
  const marker = markerFor(samples, options.pricing)
  const path = join(cwd, BACKFILL_FILE_NAME)
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  if (existing !== undefined && existing.includes(marker)) return
  const priced = samples.some(sample => priceOf(sample, options.pricing) !== undefined)
  const generatedAt = new Date().toISOString()
  const body = priced
    ? renderAmounts(samples, options.pricing, generatedAt)
    : renderInstructions(samples, options.pricing, generatedAt)
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${marker}\n\n${body}\n`, 'utf8')
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Run one backfill pass over the archived session corpus.
 *
 * The session-query service is optional: an unmounted one logs and returns
 * instead of failing the plugin. Each session is read and folded inside its
 * own failure scope, so one unreadable or malformed log costs only that
 * session's row. Nothing is written outside a session header's own `cwd`;
 * a session without one is logged and skipped.
 * @param ctx - the host context owning the logger and the optional service.
 * @param options - the resolved backfill configuration.
 * @param signal - aborts the pass when the plugin's fiber is disposed.
 */
export async function runCostBackfill(
  ctx: Context,
  options: BackfillRunOptions,
  signal: AbortSignal,
): Promise<void> {
  const query: SessionQueryEngine | undefined = ctx.get('sessionQuery', false)
  if (query === undefined) {
    ctx.logger.warn('ui-token-usage: the sessionQuery service is not mounted; skipping the TOKEN_COST.md backfill')
    return
  }
  const byCwd = new Map<string, SessionCostSample[]>()
  for (const record of await query.listSessions(signal)) {
    if (signal.aborted) return
    const { cwd, id } = record.header
    if (cwd === undefined) {
      ctx.logger.warn(`ui-token-usage: session "${id}" records no working directory; skipping it in the TOKEN_COST.md backfill`)
      continue
    }
    try {
      const loaded = await query.readSession(id)
      const bucket = byCwd.get(cwd) ?? []
      bucket.push(foldSessionUsage(id, loaded.events, options.peakHours))
      byCwd.set(cwd, bucket)
    } catch (error) {
      ctx.logger.warn(`ui-token-usage: cannot read session "${id}" for the TOKEN_COST.md backfill: ${String(error)}`)
    }
  }
  for (const [cwd, samples] of byCwd) {
    if (signal.aborted) return
    try {
      await writeReport(cwd, samples, options)
    } catch (error) {
      ctx.logger.warn(`ui-token-usage: cannot write ${join(cwd, BACKFILL_FILE_NAME)}: ${String(error)}`)
    }
  }
}
