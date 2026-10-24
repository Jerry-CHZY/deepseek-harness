/**
 * Compact numeric formatting shared by the browser readout and the host's local
 * `/usage` reply, so both render the same figure from the same rule.
 * @module @deepseek-ai/dsh-client-ui-token-usage/format
 */

/** Suffix renderers for the compact scale. */
export interface CountUnits {
  /** Render a thousands-scaled value: `12.3` becomes `12.3K`. */
  readonly thousand: (scaled: string) => string
  /** Render a millions-scaled value: `1.2` becomes `1.2M`. */
  readonly million: (scaled: string) => string
}

/** Units for host-authored text, which has no locale seat to render through. */
export const ASCII_UNITS: CountUnits = {
  thousand: scaled => `${scaled}K`,
  million: scaled => `${scaled}M`,
}

/**
 * Compact token count: 517 / 12.3K / 1.2M.
 * @param value - non-negative token count.
 * @param units - suffix renderers, owned by the caller's locale or fixed text.
 * @returns compact display string.
 */
export function formatTokens(value: number, units: CountUnits): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return units.thousand(scaled(value / 1_000))
  return units.million(scaled(value / 1_000_000))
}

/**
 * Cost with enough precision to stay non-zero on cheap sessions: two decimals
 * once the figure is a yuan, three below it, and trailing-zero-trimmed
 * micro-precision for sub-fen amounts.
 * @param value - non-negative cost amount.
 * @returns display amount that never rounds a real cost to bare zero.
 */
export function formatAmount(value: number): string {
  if (value === 0) return '0'
  if (value < 0.01) return value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')
  if (value < 1) return value.toFixed(3)
  return value.toFixed(2)
}
