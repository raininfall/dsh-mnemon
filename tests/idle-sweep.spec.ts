import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startIdleSweep, type IdleSweepHost } from '../src/host/idle-sweep.ts'

interface Harness {
  sweep: () => Promise<void>
  reviewed: string[]
  errors: unknown[]
  advance(ms: number): Promise<void>
}

function harness(overrides: Partial<IdleSweepHost> = {}): Harness & { stop: () => void } {
  const reviewed: string[] = []
  const errors: unknown[] = []
  const stop = startIdleSweep({
    at: () => '00:00',
    enabled: () => true,
    maxPerRun: () => 10,
    candidates: async () => ['session-a', 'session-b', 'session-c'],
    review: async sessionId => { reviewed.push(sessionId); return 'reviewed' },
    onError: error => { errors.push(error) },
    catchUpMs: 86_400_000,
    now: () => Date.now(),
    ...overrides,
  })
  return {
    stop,
    reviewed,
    errors,
    sweep: async () => { await vi.advanceTimersByTimeAsync(60_000) },
    advance: async ms => { await vi.advanceTimersByTimeAsync(ms) },
  }
}

describe('startIdleSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-24T23:59:00+08:00'))
  })
  afterEach(() => { vi.useRealTimers() })

  it('reviews every candidate once the wall-clock time arrives', async () => {
    const run = harness()
    expect(run.reviewed).toEqual([])
    await run.sweep()
    expect(run.reviewed).toEqual(['session-a', 'session-b', 'session-c'])
    run.stop()
  })

  it('caps one sweep so a backlog drains over later sweeps', async () => {
    const run = harness({ maxPerRun: () => 2 })
    await run.sweep()
    expect(run.reviewed).toEqual(['session-a', 'session-b'])
    await run.advance(24 * 60 * 60 * 1000)
    expect(run.reviewed.length).toBeGreaterThan(2)
    run.stop()
  })

  it('keeps the batch size for reviews that skip', async () => {
    const visited: string[] = []
    const run = harness({
      maxPerRun: () => 2,
      candidates: async () => ['session-a', 'session-b', 'session-c', 'session-d'],
      review: async sessionId => {
        visited.push(sessionId)
        return sessionId === 'session-a' || sessionId === 'session-b' ? 'skipped' : 'reviewed'
      },
    })
    await run.sweep()
    expect(visited).toEqual(['session-a', 'session-b', 'session-c', 'session-d'])
    run.stop()
  })

  it('stops scanning after a bounded run of skipped candidates', async () => {
    const visited: string[] = []
    const run = harness({
      maxPerRun: () => 1,
      candidates: async () => ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'],
      review: async sessionId => { visited.push(sessionId); return 'skipped' },
    })
    await run.sweep()
    expect(visited).toEqual(['session-a', 'session-b', 'session-c', 'session-d'])
    run.stop()
  })

  it('skips the sweep while it is disabled', async () => {
    const run = harness({ enabled: () => false })
    await run.sweep()
    expect(run.reviewed).toEqual([])
    run.stop()
  })

  it('continues with later candidates after one review fails', async () => {
    const run = harness({
      review: async sessionId => {
        if (sessionId === 'session-a') throw new Error('resume failed')
        run.reviewed.push(sessionId)
        return 'reviewed'
      },
    })
    await run.sweep()
    expect(run.reviewed).toEqual(['session-b', 'session-c'])
    expect(run.errors).toHaveLength(1)
    run.stop()
  })

  it('does not start a second sweep while one is still running', async () => {
    let release: (() => void) | undefined
    const reviewed: string[] = []
    const run = harness({
      candidates: async () => ['session-a'],
      review: async sessionId => {
        reviewed.push(sessionId)
        await new Promise<void>(resolve => { release = resolve })
        return 'reviewed'
      },
    })
    await run.sweep()
    expect(reviewed).toEqual(['session-a'])
    // The next daily tick arrives while the first sweep is still reviewing.
    await run.advance(24 * 60 * 60 * 1000)
    release?.()
    await run.advance(1_000)
    expect(reviewed).toEqual(['session-a'])
    run.stop()
  })

  it('stops reviewing after the disposer runs', async () => {
    const run = harness()
    run.stop()
    await run.advance(60_000)
    expect(run.reviewed).toEqual([])
  })
})
