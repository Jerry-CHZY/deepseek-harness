/** `tokenUsage` namespace dictionaries: the composer-dock readout's copy. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'tokenUsage'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'count.thousand': '{value}K',
  'count.million': '{value}M',
  'label.total': '合计',
  'label.context': '上下文',
  'label.input': '输入',
  'label.output': '输出',
  'label.cacheRead': '缓存读',
  'label.cacheWrite': '缓存写',
  'context.usage': '{used}/{window}',
  'cost.estimate': '≈{symbol}{amount}',
  'backfill.notice': '有 {count} 条模型路由没有配置价格，历史金额回填文件 {path} 内给出了补充价格的示范',
  'backfill.noticeNoPath': '有 {count} 条模型路由没有配置价格；本会话未记录工作目录，没有生成回填文件',
  'aria.readout': '本会话 token 用量：合计 {total}，输入 {input}，缓存读 {cacheRead}，缓存写 {cacheWrite}，输出 {output}',
  'aria.context': '上下文已用 {value}',
  'aria.cost': '估算花费 {symbol}{amount}',
} satisfies Record<string, string>

/** The `tokenUsage` namespace key union. */
export type TokenUsageKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'count.thousand': '{value}K',
  'count.million': '{value}M',
  'label.total': 'total',
  'label.context': 'context',
  'label.input': 'in',
  'label.output': 'out',
  'label.cacheRead': 'cache read',
  'label.cacheWrite': 'cache write',
  'context.usage': '{used}/{window}',
  'cost.estimate': '≈{symbol}{amount}',
  'backfill.notice': '{count} model route(s) have no configured price; the history cost file {path} shows how to add one',
  'backfill.noticeNoPath': '{count} model route(s) have no configured price; this session records no working directory, so no cost file was written',
  'aria.readout': 'This conversation token usage: {total} total, {input} input, {cacheRead} cache read, {cacheWrite} cache write, {output} output',
  'aria.context': 'Context used {value}',
  'aria.cost': 'Estimated cost {symbol}{amount}',
} satisfies Record<TokenUsageKey, string>
