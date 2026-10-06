/** `tokenUsage` namespace dictionaries: the composer-dock readout's copy. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'tokenUsage'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'count.thousand': '{value}K',
  'count.million': '{value}M',
  'label.input': '输入',
  'label.output': '输出',
  'label.cacheRead': '缓存读',
  'label.cacheWrite': '缓存写',
  'cost.estimate': '≈{symbol}{amount}',
  'aria.readout': '本会话 token 用量：输入 {input}，缓存读 {cacheRead}，缓存写 {cacheWrite}，输出 {output}',
  'aria.cost': '估算花费 {symbol}{amount}',
} satisfies Record<string, string>

/** The `tokenUsage` namespace key union. */
export type TokenUsageKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'count.thousand': '{value}K',
  'count.million': '{value}M',
  'label.input': 'in',
  'label.output': 'out',
  'label.cacheRead': 'cache read',
  'label.cacheWrite': 'cache write',
  'cost.estimate': '≈{symbol}{amount}',
  'aria.readout': 'This conversation token usage: {input} input, {cacheRead} cache read, {cacheWrite} cache write, {output} output',
  'aria.cost': 'Estimated cost {symbol}{amount}',
} satisfies Record<TokenUsageKey, string>
