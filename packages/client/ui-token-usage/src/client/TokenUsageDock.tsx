/**
 * The composer-dock token-usage readout: one line naming each non-zero
 * billing bucket of the CURRENT conversation plus the configured cost
 * estimate.
 *
 * Every number comes from the durable `tokenUsage` projection, so paging and
 * compaction cannot change it, and the slot's session scope is what makes the
 * counters per-conversation: switching sessions switches the projection the
 * readout reads. The model id feeding the price lookup comes from the durable
 * `modelSelection` projection's last-used selection, and the price table from
 * the host-registered `tokenPricing` projection. When the host's history
 * backfill found routes it cannot price, the `tokenCostBackfill` projection
 * adds a notice pointing at the generated report.
 *
 * @module @deepseek-ai/dsh-client-ui-token-usage/TokenUsageDock
 */

import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the `tokenUsage` SessionProjectionMap key merge.
import type {} from '@deepseek-ai/dsh-token-meter/client'
// Type-only: pulls the Conversation dock slot map.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the Session standard props seat (useProjection, sessionId).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatAmount, formatTokens, type CountUnits } from '../format.ts'
import { billedTokens, estimateCostCny, priceForModel } from '../pricing.ts'
import { NS } from './locales.ts'
import css from './TokenUsageDock.module.css'

/** Composed props of one composer-dock entry. */
export type TokenUsageDockProps =
  PropsRuntime<'conversation.composer.dock'> & PropsLocale<typeof NS>

/**
 * Bind the dictionary's compact-count suffixes to the shared formatter.
 * @param t - tokenUsage locale seat.
 * @returns suffix renderers for this namespace.
 */
function localeUnits(t: TranslateNS<typeof NS>): CountUnits {
  return {
    thousand: value => t('count.thousand', { value }),
    million: value => t('count.million', { value }),
  }
}

/**
 * One conversation's classified token readout; renders nothing before its
 * first billed step or before the pricing projection arrives.
 * @param props - the slot's standard session shares and this namespace's locale seat.
 * @returns the readout row, or null when the session has no billed usage.
 */
export function TokenUsageDock({ useProjection, t }: TokenUsageDockProps) {
  const usage = useProjection('tokenUsage')
  const selection = useProjection('modelSelection')
  const pricing = useProjection('tokenPricing')
  const backfill = useProjection('tokenCostBackfill')
  const pressure = useProjection('contextPressure')
  if (usage === undefined || billedTokens(usage) === 0) return null
  const units = localeUnits(t)

  // Last-used is the route that produced the billed usage; `next` only wins
  // before the first request lands.
  const model = selection?.lastUsed?.model ?? selection?.next?.model
  const price = model === undefined || pricing === undefined
    ? undefined
    : priceForModel(model, pricing.prices)
  const cost = price === undefined ? undefined : estimateCostCny(usage, price)
  const currencySymbol = pricing?.currencySymbol ?? ''
  const total = billedTokens(usage)

  // Mirrors the conversation occupancy reading: the projected next request when
  // the meter has one, else the last provider sample. Capacity is last-wins, so
  // it can trail the numerator until the next request reports usage.
  const contextUsed = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextValue = contextUsed === undefined
    ? undefined
    : pressure?.contextWindow === undefined
      ? formatTokens(contextUsed, units)
      : t('context.usage', {
        used: formatTokens(contextUsed, units),
        window: formatTokens(pressure.contextWindow, units),
      })

  const cells = [
    { key: 'total', label: t('label.total'), value: formatTokens(total, units) },
    { key: 'label.input', label: t('label.input'), value: formatTokens(usage.uncachedInputTokens, units) },
    // Cache buckets carry no information at zero and would only widen the row.
    ...(usage.cacheReadTokens === 0
      ? []
      : [{ key: 'label.cacheRead', label: t('label.cacheRead'), value: formatTokens(usage.cacheReadTokens, units) }]),
    ...(usage.cacheWriteTokens === 0
      ? []
      : [{ key: 'label.cacheWrite', label: t('label.cacheWrite'), value: formatTokens(usage.cacheWriteTokens, units) }]),
    { key: 'label.output', label: t('label.output'), value: formatTokens(usage.outputTokens, units) },
    ...(contextValue === undefined
      ? []
      : [{ key: 'context', label: t('label.context'), value: contextValue }]),
  ]
  const aria = [
    t('aria.readout', {
      total: formatTokens(total, units),
      input: formatTokens(usage.uncachedInputTokens, units),
      cacheRead: formatTokens(usage.cacheReadTokens, units),
      cacheWrite: formatTokens(usage.cacheWriteTokens, units),
      output: formatTokens(usage.outputTokens, units),
    }),
    ...(contextValue === undefined ? [] : [t('aria.context', { value: contextValue })]),
    ...(cost === undefined ? [] : [t('aria.cost', { symbol: currencySymbol, amount: formatAmount(cost) })]),
  ].join(' · ')

  return (
    <div className={css.root} data-token-usage>
      <span className={css.readout} role="group" aria-label={aria}>
        {cells.map((cell, index) => (
          <span key={cell.key} className={css.cell}>
            {index > 0 && <span className={css.sep} aria-hidden>·</span>}
            <span className={css.name}>{cell.label}</span>
            <span className={css.value}>{cell.value}</span>
          </span>
        ))}
        {cost !== undefined && <span className={css.cost}>{t('cost.estimate', {
          symbol: currencySymbol,
          amount: formatAmount(cost),
        })}</span>}
      </span>
      {backfill !== undefined && backfill.unpricedRoutes.length > 0 && (
        <span className={css.notice} role="note">
          {backfill.filePath === null
            ? t('backfill.noticeNoPath', { count: backfill.unpricedRoutes.length })
            : t('backfill.notice', {
              count: backfill.unpricedRoutes.length,
              path: backfill.filePath,
            })}
        </span>
      )}
    </div>
  )
}
