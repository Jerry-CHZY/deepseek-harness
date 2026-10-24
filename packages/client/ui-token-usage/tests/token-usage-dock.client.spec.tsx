// @vitest-environment jsdom
/**
 * The dock component's rendered readout: bucket classification, compact
 * counts, the cost figure's presence rules, and the empty state. Projection
 * reads are stubbed because the slot framework's seat is the only live input.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { TokenUsageDock, type TokenUsageDockProps } from '../src/client/TokenUsageDock.tsx'
import type { PricingProjection, TokenCostBackfillProjection } from '../src/pricing.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh)

const PRICING: PricingProjection = {
  prices: { 'test-model': { inputMiss: 2, inputHit: 0.04, output: 8 } },
  currencySymbol: '¥',
}

function usage(over: Partial<TokenUsageProjection> = {}): TokenUsageProjection {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  }
}

function renderDock(options: {
  usage?: TokenUsageProjection
  model?: string
  /** Route the model through `next` instead of `lastUsed`. */
  viaNext?: boolean
  /** Explicitly `undefined` models the projection arriving without a value. */
  pricing?: PricingProjection | undefined
  backfill?: TokenCostBackfillProjection | undefined
  /** Explicitly `undefined` models the projection arriving without a value. */
  pressure?: ContextPressureProjection | undefined
} = {}): void {
  const modelSelection = options.model === undefined
    ? undefined
    : options.viaNext === true
      ? { lastUsed: null, next: { provider: 'p', model: options.model } }
      : { lastUsed: { provider: 'p', model: options.model }, next: null }
  const projectionValues: Record<string, unknown> = {
    tokenUsage: options.usage,
    modelSelection,
    tokenPricing: 'pricing' in options ? options.pricing : PRICING,
    tokenCostBackfill: options.backfill,
    contextPressure: options.pressure,
  }
  const props = {
    t,
    sessionId: 'session',
    useProjection: (key: string) => projectionValues[key],
  } as unknown as TokenUsageDockProps
  render(<TokenUsageDock {...props} />)
}

describe('TokenUsageDock', () => {
  it('renders nothing before the session bills anything', () => {
    renderDock({ usage: usage() })
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('renders nothing while the projection is absent', () => {
    renderDock()
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('classifies input, cache read, cache write, and output with compact counts', () => {
    renderDock({
      usage: usage({
        uncachedInputTokens: 12_300,
        cacheReadTokens: 1_200,
        cacheWriteTokens: 300,
        outputTokens: 4_500,
      }),
      model: 'test-model',
    })
    const readout = screen.getByRole('group')
    expect(readout.textContent).toBe('合计18.3K·输入12.3K·缓存读1.2K·缓存写300·输出4.5K≈¥0.061')
  })

  it('drops zero cache buckets and shows the full buckets exactly', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 517, outputTokens: 42 }),
      model: 'test-model',
    })
    expect(screen.getByRole('group').textContent).toContain('输入517')
    expect(screen.getByRole('group').textContent).toContain('输出42')
    expect(screen.getByRole('group').textContent).not.toContain('缓存读')
    expect(screen.getByRole('group').textContent).not.toContain('缓存写')
  })

  it('omits the cost figure when the last-used model is unpriced', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1_000 }),
      model: 'unlisted-model',
    })
    expect(screen.getByRole('group').textContent).toContain('输入1K')
    expect(screen.getByRole('group').textContent).not.toContain('¥')
  })

  it('omits the cost figure before the pricing projection arrives', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1_000 }),
      model: 'test-model',
      pricing: undefined,
    })
    expect(screen.getByRole('group').textContent).toContain('输入1K')
    expect(screen.getByRole('group').textContent).not.toContain('¥')
  })

  it('keeps sub-fen costs visible instead of rounding them to zero', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1, outputTokens: 0 }),
      model: 'test-model',
    })
    expect(screen.getByRole('group').textContent).toContain('¥0.000002')
  })

  it('renders a whole-yuan cost with two decimals', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 }),
      model: 'test-model',
    })
    expect(screen.getByRole('group').textContent).toContain('¥10.00')
  })

  it('renders a zero estimate rather than a blank amount when prices are zero', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1_000 }),
      model: 'test-model',
      pricing: { prices: { 'test-model': { inputMiss: 0, inputHit: 0, output: 0 } }, currencySymbol: '¥' },
    })
    expect(screen.getByRole('group').textContent).toContain('≈¥0')
  })

  it('formats millions compactly', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 2_500_000, outputTokens: 1 }),
      model: 'test-model',
    })
    expect(screen.getByRole('group').textContent).toContain('输入2.5M')
  })

  it('rounds a hundred-thousand count into the thousand form', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 517_000, outputTokens: 1 }),
      model: 'test-model',
    })
    expect(screen.getByRole('group').textContent).toContain('输入517K')
  })

  it('prices through the pending next selection before the first request is consumed', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1_000 }),
      model: 'test-model',
      viaNext: true,
    })
    expect(screen.getByRole('group').textContent).toContain('¥0.010')
  })

  it('names every bucket in the accessible label, including the zero cache buckets', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 2_000, outputTokens: 1_000 }),
      model: 'test-model',
    })
    expect(screen.getByRole('group').getAttribute('aria-label'))
      .toBe('本会话 token 用量：合计 3K，输入 2K，缓存读 0，缓存写 0，输出 1K · 估算花费 ¥0.012')
  })

  it('shows context occupancy against the advertised window', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1 }),
      model: 'test-model',
      pressure: { projectedTokens: 84_000, contextWindow: 128_000 },
    })
    const readout = screen.getByRole('group')
    expect(readout.textContent).toContain('上下文84K/128K')
    expect(readout.getAttribute('aria-label')).toContain('上下文已用 84K/128K')
  })

  it('shows the used context alone until a route advertises a window', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1 }),
      model: 'test-model',
      pressure: { pressureTokens: 5_200 },
    })
    expect(screen.getByRole('group').textContent).toContain('上下文5.2K')
  })

  it('omits the context cell while the pressure projection is absent', () => {
    renderDock({ usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1 }), model: 'test-model' })
    expect(screen.getByRole('group').textContent).not.toContain('上下文')
  })

  it('points at the report when the host backfill could not price a route', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1 }),
      model: 'test-model',
      backfill: {
        hasPricedUsage: false,
        unpricedRoutes: ['openai/gpt-x'],
        filePath: '/work/TOKEN_COST.md',
      },
    })
    expect(screen.getByRole('note').textContent)
      .toContain('历史金额回填文件 /work/TOKEN_COST.md')
  })

  it('explains the missing report when the session records no working directory', () => {
    renderDock({
      usage: usage({ uncachedInputTokens: 1_000, outputTokens: 1 }),
      model: 'test-model',
      backfill: { hasPricedUsage: false, unpricedRoutes: ['openai/gpt-x'], filePath: null },
    })
    expect(screen.getByRole('note').textContent).toContain('本会话未记录工作目录')
  })

  it('renders no notice while the backfill projection is absent or fully priced', () => {
    renderDock({ usage: usage({ uncachedInputTokens: 10, outputTokens: 1 }), model: 'test-model' })
    expect(screen.queryByRole('note')).toBeNull()
    cleanup()
    renderDock({
      usage: usage({ uncachedInputTokens: 10, outputTokens: 1 }),
      model: 'test-model',
      backfill: { hasPricedUsage: true, unpricedRoutes: [], filePath: '/work/TOKEN_COST.md' },
    })
    expect(screen.queryByRole('note')).toBeNull()
  })
})
