/**
 * The `/usage` report on two surfaces: a registered slash command for clients
 * that execute commands, and a model-boundary fallback for clients that can only
 * send messages.
 *
 * Neither surface calls the provider. The fallback returns a stream with no usage
 * sample, so the loop logs the answer without settling anything: the token
 * meter's context occupancy reads the newest settlement, and a synthetic zero
 * would read as an empty context.
 * @module @deepseek-ai/dsh-client-ui-token-usage/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { ASCII_UNITS, formatAmount, formatTokens } from './format.ts'
import { billedTokens, estimateCostCny, priceForModel, type PricingProjection } from './pricing.ts'

/** The four disjoint billing buckets, as the token meter projects them. */
interface UsageState {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

/** The session's route selection, as the session controller projects it. */
interface SelectionState {
  readonly lastUsed?: { readonly model: string } | null
  readonly pending?: { readonly model: string } | null
}

/** Context pressure, as the token meter projects it. */
interface PressureState {
  readonly pressureTokens?: number
  readonly contextWindow?: number
}

/** Copy of the reply. Deployments that want another language override it. */
export interface UsageReportLabels {
  readonly total: string
  readonly input: string
  readonly cacheRead: string
  readonly cacheWrite: string
  readonly output: string
  readonly context: string
}

/** English defaults, matching the shipped dictionaries. */
export const DEFAULT_REPORT_LABELS: UsageReportLabels = {
  total: 'total',
  input: 'in',
  cacheRead: 'cache read',
  cacheWrite: 'cache write',
  output: 'out',
  context: 'context',
}

/** Figures the reply adds beside the bucket counts. */
export interface UsageReportFigures {
  /** Estimated cost; omitted when the session's route has no configured price. */
  readonly cost?: number
  /** Symbol prefixed to the cost figure. */
  readonly currencySymbol: string
  /** Occupancy of the notified context window; omitted before either side is known. */
  readonly context?: { readonly used: number; readonly window?: number }
}

/**
 * Read one registered projection's state. Its key belongs to another package,
 * so the registry is addressed through its published `stateOf` surface and a
 * registration this profile lacks reads as absent instead of failing the command.
 * @param ctx - plugin context owning the projection registry.
 * @param session - session whose folded state is read.
 * @param key - projection key registered by the owning plugin.
 * @returns the projected state, or undefined when the key is not registered.
 */
function readProjection(ctx: Context, session: Session, key: string): unknown {
  const registry = ctx.sessionProjections as unknown as {
    stateOf: (session: Session, key: string) => unknown
  }
  try {
    return registry.stateOf(session, key)
  } catch {
    // A profile without the owning plugin has no such registration.
    return undefined
  }
}

/**
 * One-line report of the session's billed usage, cost estimate, and context occupancy.
 * @param usage - the session's four billing buckets.
 * @param labels - copy for each figure.
 * @param figures - cost and context values the reply can add.
 * @returns the reply text.
 */
export function renderUsageReport(
  usage: UsageState,
  labels: UsageReportLabels,
  figures: UsageReportFigures,
): string {
  const parts = [`${labels.total} ${formatTokens(billedTokens(usage), ASCII_UNITS)}`]
  parts.push(`${labels.input} ${formatTokens(usage.uncachedInputTokens, ASCII_UNITS)}`)
  // Cache buckets carry no information at zero and would only widen the line.
  if (usage.cacheReadTokens !== 0) parts.push(`${labels.cacheRead} ${formatTokens(usage.cacheReadTokens, ASCII_UNITS)}`)
  if (usage.cacheWriteTokens !== 0) parts.push(`${labels.cacheWrite} ${formatTokens(usage.cacheWriteTokens, ASCII_UNITS)}`)
  parts.push(`${labels.output} ${formatTokens(usage.outputTokens, ASCII_UNITS)}`)
  if (figures.cost !== undefined) parts.push(`≈${figures.currencySymbol}${formatAmount(figures.cost)}`)
  if (figures.context !== undefined) {
    const used = formatTokens(figures.context.used, ASCII_UNITS)
    const occupancy = figures.context.window === undefined
      ? used
      : `${used}/${formatTokens(figures.context.window, ASCII_UNITS)}`
    parts.push(`${labels.context} ${occupancy}`)
  }
  return parts.join(' · ')
}

/**
 * Build the reply for one session, or nothing when its projections cannot supply it.
 * @param ctx - plugin context owning the services the reply reads.
 * @param session - session whose folded state is reported.
 * @param labels - copy for each figure.
 * @returns the reply text, or undefined when the token meter does not project usage.
 */
function buildReport(ctx: Context, session: Session, labels: UsageReportLabels): string | undefined {
  const usage = (readProjection(ctx, session, 'tokenUsage') as { totals?: UsageState } | undefined)?.totals
  if (usage === undefined) return undefined
  const selection = readProjection(ctx, session, 'modelSelection') as SelectionState | undefined
  const pricing = readProjection(ctx, session, 'tokenPricing') as PricingProjection | undefined
  const pressure = readProjection(ctx, session, 'contextPressure') as PressureState | undefined
  const model = selection?.lastUsed?.model ?? selection?.pending?.model
  const price = model === undefined || pricing === undefined
    ? undefined
    : priceForModel(model, pricing.prices)
  const cost = price === undefined ? undefined : estimateCostCny(usage, price)
  const used = pressure?.pressureTokens
  return renderUsageReport(usage, labels, {
    ...(cost === undefined ? {} : { cost }),
    currencySymbol: pricing?.currencySymbol ?? '',
    ...(used === undefined
      ? {}
      : { context: { used, ...(pressure?.contextWindow === undefined ? {} : { window: pressure.contextWindow }) } }),
  })
}

/**
 * Register the usage command on the interactive command surface.
 *
 * The registration waits for the commands service through its own fiber, so a
 * profile without a command surface (headless, ACP) keeps the readout and the
 * backfill without holding this plugin pending.
 * @param ctx - plugin context owning the command registration.
 * @param options - registered command name and reply copy.
 */
export function registerUsageCommand(
  ctx: Context,
  options: { readonly name: string; readonly labels: UsageReportLabels },
): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: options.name,
      description: 'Show this session\'s token usage, estimated cost, and context occupancy',
      handler: ({ agent }): CommandResult => {
        const text = buildReport(commandCtx, agent.session, options.labels)
        return text === undefined
          ? { kind: 'error', text: 'Token usage is unavailable: this profile registers no usage projection for the session.' }
          : { kind: 'success', text }
      },
    })
  })
}

/**
 * Whether the request's own human input is the trigger line.
 *
 * The harness appends instruction, context, and skill-catalog messages after the
 * typed prompt, all shaped as user-role messages; only the prompt carries
 * `source.kind === 'user'`. Comparing that message's text blocks exactly keeps a
 * prompt that merely mentions the trigger from matching.
 * @param messages - the request's model-visible messages.
 * @param trigger - exact trigger line.
 * @returns true when the newest human input is the trigger.
 */
function triggerRequested(messages: GenerateOptions['messages'], trigger: string): boolean {
  for (const message of messages.toReversed()) {
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text.trim())
      .some(text => text === trigger)
  }
  return false
}

/**
 * Shape the report as one complete text answer for the loop's stream grammar.
 *
 * The stream deliberately carries no usage sample. A settlement would be the
 * newest one the token meter sees, and its `contextPressure` fold takes the
 * occupancy numerator from exactly that sample: a synthetic zero would read as
 * an empty context even though the conversation is untouched.
 * @param text - the report to answer with.
 * @returns a stream the loop assembles into one assistant message.
 */
function reportStream(text: string): AsyncIterable<StreamChunk> {
  const chunks: readonly StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  let index = 0
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<StreamChunk>> => Promise.resolve(
        index < chunks.length
          ? { done: false, value: chunks[index++] as StreamChunk }
          : { done: true, value: undefined },
      ),
    }),
  }
}

/**
 * Answer the trigger at the model boundary, for clients that can only send
 * messages rather than execute commands.
 * @param ctx - plugin context owning the request middleware and the projections.
 * @param options - trigger line and reply copy.
 */
export function installUsageCommand(
  ctx: Context,
  options: { readonly trigger: string; readonly labels: UsageReportLabels },
): void {
  ctx.on('llm/stream', (request, next) => {
    if (!triggerRequested(request.messages, options.trigger)) return next()
    const session = request.sessionId === undefined ? undefined : ctx.sessions.get(request.sessionId)
    if (session === undefined) return next()
    const text = buildReport(ctx, session, options.labels)
    return text === undefined ? next() : reportStream(text)
  })
}
