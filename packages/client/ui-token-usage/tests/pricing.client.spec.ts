/**
 * Pricing and cost arithmetic over the tokenUsage projection's four disjoint
 * buckets: longest-prefix model resolution, the miss/hit/output formula, and
 * the "unlisted model yields no figure" rule.
 */
import { describe, expect, it } from 'vitest'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import {
  billedTokens, DEFAULT_PRICING, estimateCostCny, priceForModel, type ModelPrice,
} from '../src/pricing.ts'

const PRICE: ModelPrice = { inputMiss: 2, inputHit: 0.04, output: 8 }

function usage(over: Partial<TokenUsageProjection> = {}): TokenUsageProjection {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  }
}

describe('priceForModel', () => {
  it('matches the longest prefix, not the first insertion', () => {
    const table = {
      'deepseek-v4': { inputMiss: 1, inputHit: 1, output: 1 },
      'deepseek-v4-flash': { inputMiss: 2, inputHit: 2, output: 2 },
    }
    expect(priceForModel('deepseek-v4-flash-2026-09', table)).toBe(table['deepseek-v4-flash'])
  })

  it('returns undefined when no prefix matches', () => {
    expect(priceForModel('other-model', DEFAULT_PRICING)).toBeUndefined()
  })

  it('resolves the vision route to the longer flash entry, not the base flash price', () => {
    expect(priceForModel('deepseek-v4-flash-vision-exp', DEFAULT_PRICING))
      .toBe(DEFAULT_PRICING['deepseek-v4-flash-vision-exp'])
  })
})

describe('estimateCostCny', () => {
  it('bills uncached input and cache writes at the miss rate, cache reads at the hit rate, output at the output rate', () => {
    const result = estimateCostCny(usage({
      uncachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    }), PRICE)
    // (1M + 1M) * 2 + 1M * 0.04 + 1M * 8, in yuan.
    expect(result).toBeCloseTo(12.04, 10)
  })

  it('is zero for a session that billed nothing', () => {
    expect(estimateCostCny(usage(), PRICE)).toBe(0)
  })
})

describe('billedTokens', () => {
  it('sums every prompt-side bucket plus output', () => {
    expect(billedTokens(usage({
      uncachedInputTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
      outputTokens: 8,
    }))).toBe(15)
  })
})
