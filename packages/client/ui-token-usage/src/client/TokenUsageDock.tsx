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
 * the host-registered `tokenPricing` projection.
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
import { billedTokens, estimateCostCny, priceForModel } from '../pricing.ts'
import { NS } from './locales.ts'
import css from './TokenUsageDock.module.css'

/** Composed props of one composer-dock entry. */
export type TokenUsageDockProps =
  PropsRuntime<'conversation.composer.dock'> & PropsLocale<typeof NS>

/** One readout cell: its locale label key and its projected count. */
interface BucketRow {
  readonly key: 'label.input' | 'label.cacheRead' | 'label.cacheWrite' | 'label.output'
  readonly value: number
}

/**
 * Compact token count: 517 / 12.3K / 1.2M.
 * @param value - non-negative token count.
 * @param t - tokenUsage locale seat.
 * @returns locale-owned compact display string.
 */
function formatTokens(value: number, t: TranslateNS<typeof NS>): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('count.thousand', { value: scaled(value / 1_000) })
  return t('count.million', { value: scaled(value / 1_000_000) })
}

/**
 * Cost with enough precision to stay non-zero on cheap sessions: two decimals
 * once the figure is a yuan, three below it, and trailing-zero-trimmed
 * micro-precision for sub-fen amounts.
 * @param value - non-negative cost amount.
 * @returns display amount that never rounds a real cost to bare zero.
 */
function formatAmount(value: number): string {
  if (value === 0) return '0'
  if (value < 0.01) return value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')
  if (value < 1) return value.toFixed(3)
  return value.toFixed(2)
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
  if (usage === undefined || billedTokens(usage) === 0) return null

  // Last-used is the route that produced the billed usage; `next` only wins
  // before the first request lands.
  const model = selection?.lastUsed?.model ?? selection?.next?.model
  const price = model === undefined || pricing === undefined
    ? undefined
    : priceForModel(model, pricing.prices)
  const cost = price === undefined ? undefined : estimateCostCny(usage, price)
  const currencySymbol = pricing?.currencySymbol ?? ''

  const rows: BucketRow[] = [{ key: 'label.input', value: usage.uncachedInputTokens }]
  // Cache buckets carry no information at zero and would only widen the row.
  if (usage.cacheReadTokens !== 0) rows.push({ key: 'label.cacheRead', value: usage.cacheReadTokens })
  if (usage.cacheWriteTokens !== 0) rows.push({ key: 'label.cacheWrite', value: usage.cacheWriteTokens })
  rows.push({ key: 'label.output', value: usage.outputTokens })
  const aria = [
    t('aria.readout', {
      input: formatTokens(usage.uncachedInputTokens, t),
      cacheRead: formatTokens(usage.cacheReadTokens, t),
      cacheWrite: formatTokens(usage.cacheWriteTokens, t),
      output: formatTokens(usage.outputTokens, t),
    }),
    ...(cost === undefined ? [] : [t('aria.cost', { symbol: currencySymbol, amount: formatAmount(cost) })]),
  ].join(' · ')

  return (
    <div className={css.root} data-token-usage>
      <span className={css.readout} role="group" aria-label={aria}>
        {rows.map((row, index) => (
          <span key={row.key} className={css.cell}>
            {index > 0 && <span className={css.sep} aria-hidden>·</span>}
            <span className={css.name}>{t(row.key)}</span>
            <span className={css.value}>{formatTokens(row.value, t)}</span>
          </span>
        ))}
        {cost !== undefined && <span className={css.cost}>{t('cost.estimate', {
          symbol: currencySymbol,
          amount: formatAmount(cost),
        })}</span>}
      </span>
    </div>
  )
}
