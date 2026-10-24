/**
 * The host half: config defaults, the `tokenPricing` and `tokenCostBackfill`
 * projection units, and the registrations the browser readout depends on.
 */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { DEFAULT_BACKFILL_PRICING, DEFAULT_PEAK_HOURS } from '../src/backfill.ts'
import { DEFAULT_PRICING } from '../src/pricing.ts'
import { createBackfillProjectionDefinition, createPricingProjectionDefinition } from '../src/projection.ts'

const definition = createPricingProjectionDefinition(DEFAULT_PRICING, '¥')
const state = definition.init(undefined as never, undefined as never)
const backfill = createBackfillProjectionDefinition(DEFAULT_BACKFILL_PRICING)

/** One `request/header` event carrying a route. */
function requestHeader(provider: string, model: string): never {
  return {
    type: 'request/header',
    data: { header: { config: { provider, model } }, reason: 'initial' },
  } as never
}

/** A host context stub recording the registrations, the command, the fallback listener, and the backfill effect. */
function host(): {
  ctx: never
  register: ReturnType<typeof vi.fn>
  effect: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  command: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
} {
  const register = vi.fn()
  const effect = vi.fn()
  const warn = vi.fn()
  const command = vi.fn()
  const on = vi.fn()
  return {
    ctx: {
      sessionProjections: { register },
      effect,
      logger: { warn },
      get: () => undefined,
      on,
      inject: (_deps: string[], callback: (scope: unknown) => void) => {
        callback({ commands: { register: command } })
        return () => {}
      },
      sessions: { get: () => undefined },
    } as never,
    register,
    effect,
    warn,
    command,
    on,
  }
}

describe('tokenPricing projection unit', () => {
  it('owns a stable key and state version', () => {
    expect(definition.key).toBe('tokenPricing')
    expect(definition.stateVersion).toBe(1)
  })

  it('projects the configured table and symbol unchanged', () => {
    expect(state).toEqual({ prices: DEFAULT_PRICING, currencySymbol: '¥' })
    expect(definition.wire.view(state)).toBe(state)
  })

  it('ignores every session event and keeps one state reference', () => {
    expect(definition.apply(state, { type: 'turn/start' } as never)).toBe(state)
  })

  it('rejects a negative price at the wire schema', () => {
    expect(definition.wire.viewSchema.safeParse({
      prices: { m: { inputMiss: -1, inputHit: 0, output: 0 } },
      currencySymbol: '¥',
    }).success).toBe(false)
  })
})

describe('tokenCostBackfill projection unit', () => {
  it('owns a stable key and state version', () => {
    expect(backfill.key).toBe('tokenCostBackfill')
    expect(backfill.stateVersion).toBe(1)
  })

  it('derives the report path from the header working directory', () => {
    const cwd = join('root', 'project')
    expect(backfill.init({ cwd } as never, undefined as never)).toEqual({
      hasPricedUsage: false,
      unpricedRoutes: [],
      filePath: join(cwd, 'TOKEN_COST.md'),
    })
  })

  it('leaves the report path null when the header records no working directory', () => {
    expect(backfill.init({} as never, undefined as never)).toEqual({
      hasPricedUsage: false,
      unpricedRoutes: [],
      filePath: null,
    })
  })

  it('marks a covered route as priced and ignores every other event', () => {
    const init = backfill.init({} as never, undefined as never)
    expect(backfill.apply(init, { type: 'turn/start' } as never)).toBe(init)
    const priced = backfill.apply(init, requestHeader('deepseek', 'deepseek-v4-pro'))
    expect(priced).toEqual({ hasPricedUsage: true, unpricedRoutes: [], filePath: null })
    expect(backfill.apply(priced, requestHeader('deepseek', 'deepseek-v4-flash-2026-09'))).toBe(priced)
  })

  it('collects each unpriced route once, in first-seen order', () => {
    const init = backfill.init({} as never, undefined as never)
    const first = backfill.apply(init, requestHeader('openai', 'gpt-x'))
    expect(first.unpricedRoutes).toEqual(['openai/gpt-x'])
    const second = backfill.apply(first, requestHeader('anthropic', 'claude-y'))
    expect(second.unpricedRoutes).toEqual(['openai/gpt-x', 'anthropic/claude-y'])
    expect(backfill.apply(second, requestHeader('openai', 'gpt-x'))).toBe(second)
  })

  it('wires the state unchanged and rejects a malformed value', () => {
    const init = backfill.init({} as never, undefined as never)
    expect(backfill.wire.view(init)).toBe(init)
    expect(backfill.wire.viewSchema.safeParse({
      hasPricedUsage: 'yes',
      unpricedRoutes: [],
      filePath: null,
    }).success).toBe(false)
  })
})

describe('host apply', () => {
  it('defaults to the advisory tables, the yuan symbol, and the default peak windows', () => {
    const config = Config({})
    expect(config.pricing).toEqual({ ...DEFAULT_PRICING })
    expect(config.currencySymbol).toBe('¥')
    expect(config.backfill?.enabled).toBe(true)
    expect(config.backfill?.pricing).toEqual({ ...DEFAULT_BACKFILL_PRICING })
    expect(config.backfill?.peakHours).toEqual([...DEFAULT_PEAK_HOURS])
  })

  it('rejects a malformed peak window and a one-element price pair', () => {
    expect(() => Config({ backfill: { peakHours: [{ days: [1], start: '9:00', end: '18:00' }] } })).toThrow()
    expect(() => Config({ backfill: { peakHours: [{ days: [7], start: '09:00', end: '18:00' }] } })).toThrow()
    expect(() => Config({
      backfill: { pricing: { m: { inputMiss: [1], inputHit: [1, 2], output: [1, 2] } } },
    })).toThrow()
  })

  it('registers both projections, carrying the configured values', () => {
    const { ctx, register, effect } = host()
    const pricing = { m: { inputMiss: 1, inputHit: 0.1, output: 2 } }
    apply(ctx, { pricing, currencySymbol: '$' })
    expect(register).toHaveBeenCalledTimes(2)
    const pricingUnit = register.mock.calls[0]?.[0] as ReturnType<typeof createPricingProjectionDefinition>
    expect(pricingUnit.key).toBe('tokenPricing')
    expect(pricingUnit.init(undefined as never, undefined as never))
      .toEqual({ prices: pricing, currencySymbol: '$' })
    const backfillUnit = register.mock.calls[1]?.[0] as ReturnType<typeof createBackfillProjectionDefinition>
    expect(backfillUnit.key).toBe('tokenCostBackfill')
    expect(backfillUnit.apply(
      backfillUnit.init({} as never, undefined as never),
      requestHeader('deepseek', 'deepseek-v4-pro'),
    )).toMatchObject({ hasPricedUsage: true })
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('falls back to the advisory defaults when the config omits every key', () => {
    const { ctx, register } = host()
    apply(ctx, {})
    const pricingUnit = register.mock.calls[0]?.[0] as ReturnType<typeof createPricingProjectionDefinition>
    expect(pricingUnit.init(undefined as never, undefined as never))
      .toEqual({ prices: DEFAULT_PRICING, currencySymbol: '¥' })
    const backfillUnit = register.mock.calls[1]?.[0] as ReturnType<typeof createBackfillProjectionDefinition>
    const state = backfillUnit.init({} as never, undefined as never)
    expect(backfillUnit.apply(state, requestHeader('p', 'not-in-the-table')))
      .toMatchObject({ unpricedRoutes: ['p/not-in-the-table'] })
  })

  it('registers nothing else when the backfill is disabled', () => {
    const { ctx, register, effect } = host()
    apply(ctx, { backfill: { enabled: false } })
    expect(register).toHaveBeenCalledTimes(1)
    expect(effect).not.toHaveBeenCalled()
  })

  it('starts the backfill inside an effect and aborts it with the fiber', async () => {
    const { ctx, register, effect } = host()
    let seen: AbortSignal | undefined
    ;(ctx as { get: unknown }).get = () => ({
      listSessions: (signal: AbortSignal) => {
        seen = signal
        return Promise.resolve([])
      },
    })
    apply(ctx, Config({}))
    expect(register).toHaveBeenCalledTimes(2)
    const run = effect.mock.calls[0]?.[0] as () => () => void
    const dispose = run()
    expect(seen?.aborted).toBe(false)
    dispose()
    expect(seen?.aborted).toBe(true)
    await Promise.resolve()
  })

  it('logs a rejected backfill pass instead of failing the plugin', async () => {
    const { ctx, effect, warn } = host()
    ;(ctx as { get: unknown }).get = () => ({
      listSessions: () => Promise.reject(new Error('corpus offline')),
    })
    apply(ctx, Config({}))
    const run = effect.mock.calls[0]?.[0] as () => () => void
    run()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(1) })
    expect(String(warn.mock.calls[0]?.[0])).toContain('corpus offline')
  })
})

describe('local usage command wiring', () => {
  it('registers the command and the message fallback by default', () => {
    const { ctx, command, on } = host()
    apply(ctx, Config({}))
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ name: 'usage' }))
    expect(on).toHaveBeenCalledWith('llm/stream', expect.any(Function))
  })

  it('registers nothing when the command is disabled', () => {
    const { ctx, command, on } = host()
    apply(ctx, Config({ command: { enabled: false } }))
    expect(command).not.toHaveBeenCalled()
    expect(on).not.toHaveBeenCalled()
  })

  it('merges configured copy and name', () => {
    const { ctx, command } = host()
    apply(ctx, Config({ command: { name: 'cost', labels: { total: '合计' } } }))
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ name: 'cost' }))
  })
})
