/**
 * The `/usage` report on both surfaces: the registered command, and the
 * model-boundary fallback for clients that can only send a message.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEFAULT_REPORT_LABELS, installUsageCommand, registerUsageCommand, renderUsageReport } from '../src/command.ts'

interface RegisteredCommand {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** A context stub exposing the command surface and the projection registry. */
function host(states: Record<string, unknown> = {}) {
  const registered: RegisteredCommand[] = []
  const sessionProjections = {
    stateOf: (_session: unknown, key: string) => {
      if (!(key in states)) throw new Error(`no projection ${key}`)
      return states[key]
    },
  }
  const ctx = {
    sessionProjections,
    inject: (_deps: string[], callback: (scope: unknown) => void) => {
      callback({
        sessionProjections,
        commands: { register: (command: RegisteredCommand) => { registered.push(command); return () => {} } },
      })
      return () => {}
    },
  } as unknown as Context
  return { ctx, registered }
}

const USAGE = {
  uncachedInputTokens: 12_300,
  cacheReadTokens: 1_200,
  cacheWriteTokens: 0,
  outputTokens: 4_500,
}

const CHINESE = {
  ...DEFAULT_REPORT_LABELS,
  total: '合计',
  input: '输入',
  cacheRead: '缓存读',
  output: '输出',
  context: '上下文',
}

const SESSION = {} as never

describe('renderUsageReport', () => {
  it('renders the total, non-zero buckets, the cost, and the windowed occupancy', () => {
    expect(renderUsageReport(USAGE, DEFAULT_REPORT_LABELS, {
      cost: 0.060_648,
      currencySymbol: '¥',
      context: { used: 84_000, window: 128_000 },
    })).toBe('total 18K · in 12.3K · cache read 1.2K · out 4.5K · ≈¥0.061 · context 84K/128K')
  })

  it('drops zero cache buckets and shows occupancy alone without a window', () => {
    expect(renderUsageReport(
      { uncachedInputTokens: 517, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 42 },
      DEFAULT_REPORT_LABELS,
      { currencySymbol: '', context: { used: 5_200 } },
    )).toBe('total 559 · in 517 · out 42 · context 5.2K')
  })

  it('keeps a written cache bucket and omits absent figures', () => {
    expect(renderUsageReport(
      { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 2_000, outputTokens: 3 },
      DEFAULT_REPORT_LABELS,
      { currencySymbol: '¥' },
    )).toBe('total 2K · in 1 · cache write 2K · out 3')
  })

  it('scales a million-token session', () => {
    expect(renderUsageReport(
      { uncachedInputTokens: 1_234_567, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      DEFAULT_REPORT_LABELS,
      { currencySymbol: '¥' },
    )).toBe('total 1.2M · in 1.2M · out 0')
  })
})

describe('registerUsageCommand', () => {
  it('registers the configured name on the command surface', () => {
    const { ctx, registered } = host()
    registerUsageCommand(ctx, { name: 'usage', labels: DEFAULT_REPORT_LABELS })
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe('usage')
    expect(registered[0]?.description).toContain('token usage')
  })

  it('answers from the session projections with the configured copy', () => {
    const { ctx, registered } = host({
      tokenUsage: { totals: USAGE },
      modelSelection: { lastUsed: { model: 'm' }, pending: null },
      tokenPricing: { prices: { m: { inputMiss: 2, inputHit: 0.04, output: 8 } }, currencySymbol: '¥' },
      contextPressure: { pressureTokens: 84_000, contextWindow: 128_000, surfaceTokens: 0 },
    })
    registerUsageCommand(ctx, { name: 'usage', labels: CHINESE })
    const result = registered[0]?.handler({ agent: { session: SESSION } } as never)
    expect(result).toEqual({
      kind: 'success',
      text: '合计 18K · 输入 12.3K · 缓存读 1.2K · 输出 4.5K · ≈¥0.061 · 上下文 84K/128K',
    })
  })

  it('reports without a cost when the session has no priced selection', () => {
    const { ctx, registered } = host({ tokenUsage: { totals: USAGE } })
    registerUsageCommand(ctx, { name: 'usage', labels: DEFAULT_REPORT_LABELS })
    expect(registered[0]?.handler({ agent: { session: SESSION } } as never)).toEqual({
      kind: 'success',
      text: 'total 18K · in 12.3K · cache read 1.2K · out 4.5K',
    })
  })

  it('reports the last provider sample when the meter has no projection for the next request', () => {
    const { ctx, registered } = host({
      tokenUsage: { totals: USAGE },
      contextPressure: { pressureTokens: 5_200 },
    })
    registerUsageCommand(ctx, { name: 'usage', labels: DEFAULT_REPORT_LABELS })
    const result = registered[0]?.handler({ agent: { session: SESSION } } as never) as { text: string }
    expect(result.text).toContain('context 5.2K')
  })

  it('fails the command when no usage projection is registered', () => {
    const { ctx, registered } = host({})
    registerUsageCommand(ctx, { name: 'usage', labels: DEFAULT_REPORT_LABELS })
    expect(registered[0]?.handler({ agent: { session: SESSION } } as never)).toEqual({
      kind: 'error',
      text: 'Token usage is unavailable: this profile registers no usage projection for the session.',
    })
  })

  it('leaves the plugin untouched when no command surface exists', () => {
    const inject = vi.fn()
    const ctx = { inject } as unknown as Context
    registerUsageCommand(ctx, { name: 'usage', labels: DEFAULT_REPORT_LABELS })
    expect(inject).toHaveBeenCalledWith(['commands'], expect.any(Function))
  })
})

type Listener = (request: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>

/** A context stub exposing the request middleware, session registry, and projections. */
function fallbackHost(
  states: Record<string, unknown> = {},
  sessions: Record<string, unknown> = {},
) {
  const listeners: Listener[] = []
  const ctx = {
    on: (_name: string, listener: Listener) => {
      listeners.push(listener)
      return () => {}
    },
    sessions: { get: (id: string) => sessions[id] },
    sessionProjections: {
      stateOf: (_session: unknown, key: string) => {
        if (!(key in states)) throw new Error(`no projection ${key}`)
        return states[key]
      },
    },
  } as unknown as Context
  return { ctx, listeners }
}

function request(text: string | undefined, sessionId: string | undefined = 's1'): GenerateOptions {
  const messages = text === undefined
    ? []
    : [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }]
  return {
    provider: 'test',
    model: 'test',
    messages,
    ...(sessionId === undefined ? {} : { sessionId }),
  } as unknown as GenerateOptions
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The provider stream a delegated request would have produced. */
function upstream(): AsyncIterable<StreamChunk> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  }
}

describe('installUsageCommand', () => {
  it('answers the trigger without a provider call or a usage settlement', async () => {
    const { ctx, listeners } = fallbackHost({
      tokenUsage: { totals: USAGE },
      modelSelection: { lastUsed: { model: 'm' }, pending: null },
      tokenPricing: { prices: { m: { inputMiss: 2, inputHit: 0.04, output: 8 } }, currencySymbol: '¥' },
      contextPressure: { pressureTokens: 84_000, contextWindow: 128_000, surfaceTokens: 0 },
    }, { s1: {} })
    installUsageCommand(ctx, { trigger: '/usage', labels: CHINESE })
    const next = vi.fn(() => upstream())
    const chunks = await collect(listeners[0]!(request('/usage'), next))

    expect(next).not.toHaveBeenCalled()
    const text = chunks
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text).toBe('合计 18K · 输入 12.3K · 缓存读 1.2K · 输出 4.5K · ≈¥0.061 · 上下文 84K/128K')
    // A settlement would be the newest sample the context meter reads.
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('delegates when the newest human message is another prompt', () => {
    const { ctx, listeners } = fallbackHost({ tokenUsage: { totals: USAGE } }, { s1: {} })
    installUsageCommand(ctx, { trigger: '/usage', labels: DEFAULT_REPORT_LABELS })
    const delegated = upstream()
    const next = vi.fn(() => delegated)
    expect(listeners[0]!(request('/usage extra'), next)).toBe(delegated)
  })

  it('ignores a trigger-looking line that the harness injected', () => {
    const { ctx, listeners } = fallbackHost({ tokenUsage: { totals: USAGE } }, { s1: {} })
    installUsageCommand(ctx, { trigger: '/usage', labels: DEFAULT_REPORT_LABELS })
    const delegated = upstream()
    const next = vi.fn(() => delegated)
    const injected = {
      provider: 'test',
      model: 'test',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '/usage' }], source: { kind: 'plugin' } }],
    } as unknown as GenerateOptions
    expect(listeners[0]!(injected, next)).toBe(delegated)
  })

  it('delegates when the request names no live session', () => {
    const { ctx, listeners } = fallbackHost({ tokenUsage: { totals: USAGE } })
    installUsageCommand(ctx, { trigger: '/usage', labels: DEFAULT_REPORT_LABELS })
    const delegated = upstream()
    const next = vi.fn(() => delegated)
    expect(listeners[0]!(request('/usage'), next)).toBe(delegated)
  })

  it('delegates when the request carries no session id', () => {
    const { ctx, listeners } = fallbackHost({ tokenUsage: { totals: USAGE } }, { s1: {} })
    installUsageCommand(ctx, { trigger: '/usage', labels: DEFAULT_REPORT_LABELS })
    const delegated = upstream()
    const next = vi.fn(() => delegated)
    const sessionless = {
      provider: 'test',
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: '/usage' }], source: { kind: 'user' } }],
    } as unknown as GenerateOptions
    expect(listeners[0]!(sessionless, next)).toBe(delegated)
  })

  it('delegates when the token meter does not project usage', () => {
    const { ctx, listeners } = fallbackHost({}, { s1: {} })
    installUsageCommand(ctx, { trigger: '/usage', labels: DEFAULT_REPORT_LABELS })
    const delegated = upstream()
    const next = vi.fn(() => delegated)
    expect(listeners[0]!(request('/usage'), next)).toBe(delegated)
  })
})
