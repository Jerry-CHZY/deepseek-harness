/**
 * The host backfill: peak/off-peak bucketing by Beijing-time window, the
 * turn/step replacement rule, and one full pass over a fake archived corpus
 * writing `TOKEN_COST.md` into a temporary working directory.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKFILL_FILE_NAME,
  DEFAULT_BACKFILL_PRICING,
  DEFAULT_PEAK_HOURS,
  foldSessionUsage,
  isPeakInstant,
  runCostBackfill,
  type BackfillRunOptions,
} from '../src/backfill.ts'

/** Friday 2026-09-18 10:00 Beijing — inside the morning peak window. */
const PEAK = Date.UTC(2026, 8, 18, 2, 0)
/** Friday 2026-09-18 13:00 Beijing — the midday gap. */
const OFF_PEAK = Date.UTC(2026, 8, 18, 5, 0)
/** Friday 2026-09-18 17:00 Beijing — inside the afternoon peak window. */
const AFTERNOON_PEAK = Date.UTC(2026, 8, 18, 9, 0)

const SESSION = 'session-a' as never

const OPTIONS: BackfillRunOptions = { pricing: DEFAULT_BACKFILL_PRICING, peakHours: DEFAULT_PEAK_HOURS }

const dirs: string[] = []
const controllers: AbortController[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  controllers.splice(0)
})

/** One fresh temporary working directory, removed after the spec. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-token-usage-'))
  dirs.push(dir)
  return dir
}

/** One `request/header` event. */
function headerEvent(seq: number, time: number, provider: string, model: string): never {
  return {
    type: 'request/header',
    seq,
    time,
    data: { header: { config: { provider, model } }, reason: 'initial' },
  } as never
}

/** One settlement sample as the provider reports it. */
type ReportedUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One `assistant/message` event, with or without a settlement sample or stream. */
function usageEvent(
  seq: number,
  time: number,
  turn: number,
  step: number,
  usage?: ReportedUsage,
  stream: readonly never[] = [],
): never {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, message: {}, stream, ...usage === undefined ? {} : { usage } },
  } as never
}

/** One failed `assistant/attempt` event carrying its compact stream. */
function attemptEvent(seq: number, time: number, turn: number, step: number, stream: readonly never[]): never {
  return { type: 'assistant/attempt', seq, time, data: { turn, step, stream } } as never
}

/** One `llm/retry-started` transition for a failed step. */
function retryStartedEvent(seq: number, time: number, turn: number, step: number): never {
  return { type: 'llm/retry-started', seq, time, data: { retryId: 'retry-1', turn, step, retry: 1 } } as never
}

/** One compact stream holding usage chunks interleaved with records that carry none. */
function usageStream(...usages: readonly ReportedUsage[]): never[] {
  const records: unknown[] = [{ type: 'text-chunks', texts: ['hi'] }]
  for (const usage of usages) {
    records.push({ type: 'chunk', chunk: { type: 'usage', usage } })
    records.push({ type: 'chunk', chunk: { type: 'text-delta', text: 'x' } })
  }
  return records as never[]
}

/** One archived session the fake corpus serves. */
interface FakeSession {
  id: string
  cwd?: string
  events?: readonly never[]
  /** Reject `readSession` for this session. */
  unreadable?: true
}

/** A `ctx.sessionQuery` stub over a fixed record list. */
function corpus(sessions: readonly FakeSession[], onList?: () => void): unknown {
  return {
    listSessions: () => {
      onList?.()
      return Promise.resolve(sessions.map(session => ({
        header: { id: session.id, ...session.cwd === undefined ? {} : { cwd: session.cwd } },
      })))
    },
    readSession: (id: string) => {
      const session = sessions.find(candidate => candidate.id === id) as FakeSession
      return session.unreadable === true
        ? Promise.reject(new Error(`log for ${id} is unreadable`))
        : Promise.resolve({ events: session.events ?? [] })
    },
  }
}

/** A host context stub over one optional session-query implementation. */
function host(query: unknown): { ctx: never; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  return { ctx: { get: () => query, logger: { warn } } as never, warn }
}

/** A fresh abort controller owned by the spec's teardown list. */
function controller(): AbortController {
  const signal = new AbortController()
  controllers.push(signal)
  return signal
}

describe('isPeakInstant', () => {
  it('splits Beijing-time weekdays into the two default windows', () => {
    expect(isPeakInstant(PEAK, DEFAULT_PEAK_HOURS)).toBe(true)
    // 09:00 is inclusive, 12:00 exclusive, and 08:00, the midday gap, and the
    // weekend all fall outside.
    expect(isPeakInstant(Date.UTC(2026, 8, 18, 1, 0), DEFAULT_PEAK_HOURS)).toBe(true)
    expect(isPeakInstant(Date.UTC(2026, 8, 18, 4, 0), DEFAULT_PEAK_HOURS)).toBe(false)
    expect(isPeakInstant(Date.UTC(2026, 8, 18, 0, 0), DEFAULT_PEAK_HOURS)).toBe(false)
    expect(isPeakInstant(OFF_PEAK, DEFAULT_PEAK_HOURS)).toBe(false)
    expect(isPeakInstant(Date.UTC(2026, 8, 19, 2, 0), DEFAULT_PEAK_HOURS)).toBe(false)
    expect(isPeakInstant(AFTERNOON_PEAK, DEFAULT_PEAK_HOURS)).toBe(true)
  })

  it('treats an empty window list as permanently off-peak', () => {
    expect(isPeakInstant(PEAK, [])).toBe(false)
  })
})

describe('foldSessionUsage', () => {
  it('replaces a repeated turn/step sample instead of adding it', () => {
    const sample = foldSessionUsage(SESSION, [
      headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
      usageEvent(1, PEAK, 1, 1, { inputTokens: 1_000, outputTokens: 10 }),
      usageEvent(2, PEAK, 1, 1, { inputTokens: 3_000, outputTokens: 40 }),
    ], DEFAULT_PEAK_HOURS)
    expect(sample.peak).toEqual({
      uncachedInputTokens: 3_000,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('moves a replaced sample to the period of the settlement that replaced it', () => {
    const peakFirst = foldSessionUsage(SESSION, [
      usageEvent(0, PEAK, 1, 1, { inputTokens: 1_000, outputTokens: 0 }),
      usageEvent(1, OFF_PEAK, 1, 1, { inputTokens: 2_000, outputTokens: 0 }),
    ], DEFAULT_PEAK_HOURS)
    expect(peakFirst.peak.uncachedInputTokens).toBe(0)
    expect(peakFirst.offPeak.uncachedInputTokens).toBe(2_000)

    const offPeakFirst = foldSessionUsage(SESSION, [
      usageEvent(0, OFF_PEAK, 1, 1, { inputTokens: 1_000, outputTokens: 0 }),
      usageEvent(1, PEAK, 1, 1, { inputTokens: 2_000, outputTokens: 0 }),
    ], DEFAULT_PEAK_HOURS)
    expect(offPeakFirst.offPeak.uncachedInputTokens).toBe(0)
    expect(offPeakFirst.peak.uncachedInputTokens).toBe(2_000)
  })

  it('accumulates distinct steps and splits them by the settlement timestamp', () => {
    const sample = foldSessionUsage(SESSION, [
      headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
      usageEvent(1, PEAK, 1, 1, { inputTokens: 1_000, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 9 }),
      usageEvent(2, OFF_PEAK, 1, 2, { inputTokens: 2_000, outputTokens: 6 }),
      usageEvent(3, AFTERNOON_PEAK, 2, 1, { inputTokens: 3_000, outputTokens: 4 }),
    ], DEFAULT_PEAK_HOURS)
    expect(sample.peak).toEqual({
      uncachedInputTokens: 4_000,
      outputTokens: 9,
      cacheReadTokens: 7,
      cacheWriteTokens: 9,
    })
    expect(sample.offPeak).toEqual({
      uncachedInputTokens: 2_000,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(sample.lastSeq).toBe(3)
  })

  it('records routes in first-seen order and keeps the last one in force', () => {
    const sample = foldSessionUsage(SESSION, [
      headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
      headerEvent(1, PEAK, 'deepseek', 'deepseek-v4-flash'),
      headerEvent(2, PEAK, 'deepseek', 'deepseek-v4-pro'),
      { type: 'turn/start', seq: 3, time: PEAK, data: { turn: 1 } } as never,
      usageEvent(4, PEAK, 1, 1),
      { type: 'turn/end', seq: 5, time: PEAK, data: { turn: 1, reason: { kind: 'completed' } } } as never,
    ], DEFAULT_PEAK_HOURS)
    expect(sample.routes).toEqual(['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash'])
    expect(sample.route).toBe('deepseek/deepseek-v4-pro')
  })

  it('counts a failed attempt and the retry that followed it as two billed attempts', () => {
    const sample = foldSessionUsage(SESSION, [
      headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
      // No slot to close yet, so this transition is a no-op.
      retryStartedEvent(1, PEAK, 1, 1),
      attemptEvent(2, PEAK, 1, 1, usageStream({ inputTokens: 1_000, outputTokens: 0 })),
      retryStartedEvent(3, PEAK, 1, 1),
      usageEvent(4, PEAK, 1, 1, { inputTokens: 2_000, outputTokens: 0 }),
    ], DEFAULT_PEAK_HOURS)
    expect(sample.peak.uncachedInputTokens).toBe(3_000)
  })

  it('replaces within one step when no retry intervened, reading stream-embedded usage', () => {
    const sample = foldSessionUsage(SESSION, [
      headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
      attemptEvent(1, PEAK, 1, 1, usageStream({ inputTokens: 1_000, outputTokens: 0 })),
      // The message restates the same settlement, so the attempt is not billed twice.
      usageEvent(2, PEAK, 1, 1, { inputTokens: 1_000, outputTokens: 0 }),
      // A message carrying no usage field still settles from its own stream.
      usageEvent(3, PEAK, 1, 2, undefined, usageStream({ inputTokens: 500, outputTokens: 20 })),
    ], DEFAULT_PEAK_HOURS)
    expect(sample.peak.uncachedInputTokens).toBe(1_500)
    expect(sample.peak.outputTokens).toBe(20)
  })

  it('leaves the replacement slot open for a retry recorded against another step', () => {
    const sample = foldSessionUsage(SESSION, [
      attemptEvent(0, PEAK, 1, 1, usageStream({ inputTokens: 1_000, outputTokens: 0 })),
      retryStartedEvent(1, PEAK, 1, 2),
      usageEvent(2, PEAK, 1, 1, { inputTokens: 2_000, outputTokens: 0 }),
    ], DEFAULT_PEAK_HOURS)
    expect(sample.peak.uncachedInputTokens).toBe(2_000)
  })

  it('reads the last usage chunk of a stream, ignoring chunks that carry none', () => {
    const sample = foldSessionUsage(SESSION, [
      attemptEvent(0, PEAK, 1, 1, usageStream({ inputTokens: 100, outputTokens: 1 }, { inputTokens: 400, outputTokens: 4 })),
    ], DEFAULT_PEAK_HOURS)
    expect(sample.peak.uncachedInputTokens).toBe(400)
    expect(sample.peak.outputTokens).toBe(4)
  })

  it('folds an empty log to zero buckets, no routes, and the empty seq', () => {
    const sample = foldSessionUsage(SESSION, [], DEFAULT_PEAK_HOURS)
    expect(sample).toEqual({
      sessionId: SESSION,
      routes: [],
      route: null,
      peak: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      offPeak: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      lastSeq: -1,
    })
  })
})

describe('runCostBackfill', () => {
  it('writes one amounts table for a working directory with a priced route', async () => {
    const dir = await tempDir()
    const { ctx, warn } = host(corpus([
      {
        id: 'tiny',
        cwd: dir,
        events: [
          headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
          usageEvent(1, PEAK, 1, 1, { inputTokens: 1, outputTokens: 0 }),
        ],
      },
      {
        id: 'sub-yuan',
        cwd: dir,
        events: [
          headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
          usageEvent(1, PEAK, 1, 1, { inputTokens: 10_000, outputTokens: 0 }),
        ],
      },
      {
        id: 'yuan',
        cwd: dir,
        events: [
          headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
          usageEvent(1, PEAK, 1, 1, { inputTokens: 2_000_000, outputTokens: 0 }),
          usageEvent(2, OFF_PEAK, 1, 2, { inputTokens: 1_000_000, outputTokens: 0 }),
        ],
      },
      {
        id: 'unpriced',
        cwd: dir,
        events: [
          headerEvent(0, PEAK, 'openai', 'gpt-x'),
          usageEvent(1, PEAK, 1, 1, { inputTokens: 500, outputTokens: 0 }),
        ],
      },
      { id: 'routeless', cwd: dir, events: [usageEvent(0, PEAK, 1, 1, { inputTokens: 7, outputTokens: 0 })] },
    ]))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(warn).not.toHaveBeenCalled()
    const report = await readFile(join(dir, BACKFILL_FILE_NAME), 'utf8')
    expect(report).toContain('Historical cost backfill over 5 archived session(s)')
    expect(report).toContain('| `tiny` | `deepseek/deepseek-v4-pro` | 1 | 0 | 0 | 0 | ¥0.000009 | ¥0 | ¥0.000009 |')
    expect(report).toContain('| `sub-yuan` | `deepseek/deepseek-v4-pro` | 10000 | 0 | 0 | 0 | ¥0.090 | ¥0 | ¥0.090 |')
    expect(report).toContain('| `yuan` | `deepseek/deepseek-v4-pro` | 3000000 | 0 | 0 | 0 | ¥18.00 | ¥4.50 | ¥22.50 |')
    expect(report).toContain('| `unpriced` | `openai/gpt-x` | 500 | 0 | 0 | 0 | — | — | — |')
    expect(report).toContain('| `routeless` | — | 7 | 0 | 0 | 0 | — | — | — |')
    expect(report).toMatch(/^<!-- dsh-token-cost-backfill: fold=\d+ config=[0-9a-f]{16} sessions=/u)
    expect(await readdir(dir)).toEqual([BACKFILL_FILE_NAME])
  })

  it('writes pricing instructions when no recorded route is priced', async () => {
    const dir = await tempDir()
    const { ctx, warn } = host(corpus([
      { id: 'a', cwd: dir, events: [headerEvent(0, PEAK, 'openai', 'gpt-x')] },
      { id: 'b', cwd: dir, events: [headerEvent(0, PEAK, 'openai', 'gpt-x')] },
      { id: 'c', cwd: dir, events: [headerEvent(0, PEAK, 'anthropic', 'claude-y')] },
    ]))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(warn).not.toHaveBeenCalled()
    const report = await readFile(join(dir, BACKFILL_FILE_NAME), 'utf8')
    expect(report).toContain('No configured price matched the recorded model route(s)')
    expect(report).toContain('- `anthropic/claude-y` — 1 session(s)')
    expect(report).toContain('- `openai/gpt-x` — 2 session(s)')
    expect(report).toContain('- id: ui-token-usage')
    expect(report).toContain("  name: '@deepseek-ai/dsh-client-ui-token-usage'")
    expect(report).toContain('          inputMiss: [4.5, 9]')
    // Sorted first-seen order, not corpus or insertion order.
    expect(report.indexOf('anthropic/claude-y')).toBeLessThan(report.indexOf('openai/gpt-x'))
  })

  it('lists only the routes the table misses when a session switched models', async () => {
    const dir = await tempDir()
    const { ctx, warn } = host(corpus([{
      id: 'switcher',
      cwd: dir,
      events: [
        headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
        headerEvent(1, PEAK, 'openai', 'gpt-x'),
      ],
    }]))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(warn).not.toHaveBeenCalled()
    const report = await readFile(join(dir, BACKFILL_FILE_NAME), 'utf8')
    expect(report).toContain('No configured price matched the recorded model route(s)')
    expect(report).toContain('- `openai/gpt-x` — 1 session(s)')
    expect(report).not.toContain('deepseek/deepseek-v4-pro`')
  })

  it('skips a report whose marker already matches, and rewrites it when the config changes', async () => {
    const dir = await tempDir()
    const sessions: FakeSession[] = [
      {
        id: 'a',
        cwd: dir,
        events: [
          headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
          usageEvent(1, PEAK, 1, 1, { inputTokens: 1_000_000, outputTokens: 0 }),
        ],
      },
    ]
    const { ctx } = host(corpus(sessions))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    const path = join(dir, BACKFILL_FILE_NAME)
    const written = await readFile(path, 'utf8')
    // Same fold version, price table, and watermarks: the write is skipped and
    // the sentinel survives.
    await writeFile(path, `${written}SENTINEL\n`, 'utf8')
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(await readFile(path, 'utf8')).toContain('SENTINEL')

    await runCostBackfill(ctx, {
      pricing: { 'deepseek-v4-pro': { inputMiss: [1, 2], inputHit: [0, 0], output: [0, 0] } },
      peakHours: DEFAULT_PEAK_HOURS,
    }, controller().signal)
    const rewritten = await readFile(path, 'utf8')
    expect(rewritten).not.toContain('SENTINEL')
    expect(rewritten).toContain('¥2.00')
  })

  it('rewrites a report whose marker carries another fold-semantics version', async () => {
    const dir = await tempDir()
    const { ctx } = host(corpus([{
      id: 'a',
      cwd: dir,
      events: [
        headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro'),
        usageEvent(1, PEAK, 1, 1, { inputTokens: 1_000_000, outputTokens: 0 }),
      ],
    }]))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    const path = join(dir, BACKFILL_FILE_NAME)
    const written = await readFile(path, 'utf8')
    expect(written).toMatch(/fold=\d+/u)
    // Everything else in the marker stays identical, so only the fold version
    // can force the rewrite.
    await writeFile(path, `${written.replace(/fold=\d+/u, 'fold=0')}SENTINEL\n`, 'utf8')
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    const rewritten = await readFile(path, 'utf8')
    expect(rewritten).not.toContain('fold=0')
    expect(rewritten).not.toContain('SENTINEL')
    expect(rewritten).toMatch(/fold=\d+/u)
    expect(rewritten).toContain('¥9.00')
  })

  it('writes nothing when no session records a route', async () => {
    const dir = await tempDir()
    const { ctx, warn } = host(corpus([
      { id: 'a', cwd: dir, events: [usageEvent(0, PEAK, 1, 1, { inputTokens: 7, outputTokens: 0 })] },
    ]))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(warn).not.toHaveBeenCalled()
    expect(await readdir(dir)).toEqual([])
  })

  it('skips a session without a working directory and logs it', async () => {
    const dir = await tempDir()
    const { ctx, warn } = host(corpus([
      { id: 'homeless', events: [headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro')] },
      { id: 'homed', cwd: dir, events: [headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro')] },
    ]))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('records no working directory')
    expect(await readdir(dir)).toEqual([BACKFILL_FILE_NAME])
  })

  it('isolates one unreadable session and keeps the rest of the pass', async () => {
    const dir = await tempDir()
    const { ctx, warn } = host(corpus([
      { id: 'broken', cwd: dir, unreadable: true },
      { id: 'sound', cwd: dir, events: [headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro')] },
    ]))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('log for broken is unreadable')
    expect(await readFile(join(dir, BACKFILL_FILE_NAME), 'utf8')).toContain('`sound`')
  })

  it('logs and returns when the session-query service is not mounted', async () => {
    const { ctx, warn } = host(undefined)
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('sessionQuery service is not mounted')
  })

  it('stops before reading when the signal is already aborted', async () => {
    const dir = await tempDir()
    const signal = controller()
    const { ctx, warn } = host(corpus(
      [{ id: 'a', cwd: dir, events: [headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro')] }],
      () => { signal.abort() },
    ))
    await runCostBackfill(ctx, OPTIONS, signal.signal)
    expect(warn).not.toHaveBeenCalled()
    expect(await readdir(dir)).toEqual([])
  })

  it('stops before writing when the signal aborts mid-pass', async () => {
    const dir = await tempDir()
    const signal = controller()
    const query = corpus([{ id: 'a', cwd: dir, events: [headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro')] }])
    ;(query as { readSession: unknown }).readSession = () => {
      signal.abort()
      return Promise.resolve({ events: [headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro')] })
    }
    const { ctx, warn } = host(query)
    await runCostBackfill(ctx, OPTIONS, signal.signal)
    expect(warn).not.toHaveBeenCalled()
    expect(await readdir(dir)).toEqual([])
  })

  it('logs a failed report write and removes its temporary file', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, BACKFILL_FILE_NAME))
    const { ctx, warn } = host(corpus([
      { id: 'a', cwd: dir, events: [headerEvent(0, PEAK, 'deepseek', 'deepseek-v4-pro')] },
    ]))
    await runCostBackfill(ctx, OPTIONS, controller().signal)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('cannot write')
    expect(await readdir(dir)).toEqual([BACKFILL_FILE_NAME])
  })
})
