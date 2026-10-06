/**
 * The host half: config defaults, the `tokenPricing` projection unit's
 * constant state, and the registration the browser readout depends on.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { DEFAULT_PRICING } from '../src/pricing.ts'
import { createPricingProjectionDefinition } from '../src/projection.ts'

const definition = createPricingProjectionDefinition(DEFAULT_PRICING, '¥')
const state = definition.init(undefined as never, undefined as never)

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

describe('host apply', () => {
  it('defaults to the advisory table and the yuan symbol', () => {
    const config = Config({})
    expect(config.pricing).toEqual({ ...DEFAULT_PRICING })
    expect(config.currencySymbol).toBe('¥')
  })

  it('registers one unit carrying the configured values', () => {
    const register = vi.fn()
    const pricing = { m: { inputMiss: 1, inputHit: 0.1, output: 2 } }
    apply({ sessionProjections: { register } } as never, { pricing, currencySymbol: '$' })
    expect(register).toHaveBeenCalledTimes(1)
    const registered = register.mock.calls[0]?.[0] as ReturnType<typeof createPricingProjectionDefinition>
    expect(registered.key).toBe('tokenPricing')
    expect(registered.init(undefined as never, undefined as never))
      .toEqual({ prices: pricing, currencySymbol: '$' })
  })

  it('falls back to the advisory defaults when the config omits both keys', () => {
    const register = vi.fn()
    apply({ sessionProjections: { register } } as never, {})
    const registered = register.mock.calls[0]?.[0] as ReturnType<typeof createPricingProjectionDefinition>
    expect(registered.init(undefined as never, undefined as never))
      .toEqual({ prices: DEFAULT_PRICING, currencySymbol: '¥' })
  })
})
