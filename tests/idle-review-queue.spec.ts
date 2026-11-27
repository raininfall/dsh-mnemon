import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'

const DUE = new Date('2026-11-27T00:00:00+08:00').getTime()

interface SessionRecord {
  header: { id: string; createdAt: number; cwd?: string; parentSession?: string; origin?: 'subagent'; delegationDepth?: number }
}

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mnemon-queue-'))
  vi.stubEnv('MNEMON_DATA_DIR', root)
  return root
}

function writeMarkers(root: string, markers: Record<string, { at: number; outcome: 'reviewed' | 'skipped' }>): void {
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'state', 'review-markers.json'), JSON.stringify({ version: 1, markers }))
}

function lifecycleFor(records: readonly SessionRecord[], options: { archived?: readonly string[]; titles?: Record<string, string>; rows?: number } = {}) {
  const listSessions = vi.fn(async () => records)
  const readTitleSnapshots = vi.fn(async (ids: readonly string[]) => ids
    .filter(id => options.titles?.[id] !== undefined)
    .map(id => ({ sessionId: id, status: 'fulfilled' as const, value: { title: { title: options.titles![id]! } } })))
  const host = {
    get: (name: string) => name === 'sessionQuery'
      ? { listSessions, readTitleSnapshots }
      : name === 'workspaceRegistry' ? { archivedSessionIds: options.archived ?? [] } : undefined,
    agents: { get: () => undefined },
  } as unknown as HostContextShape
  const lifecycle = new MnemonLifecycle(host, {} as never, resolveConfig({ idleReview: { at: '00:00' } }))
  return { lifecycle, listSessions, readTitleSnapshots }
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

describe('idle review queue', () => {
  it('lists the Sessions the daily clock still owes, oldest first, with titles', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T12:00:00+08:00'))
    const root = dataRoot()
    writeMarkers(root, {
      'marked-now': { at: DUE, outcome: 'reviewed' },
      'marked-earlier': { at: DUE - 86_400_000, outcome: 'reviewed' },
    })
    const { lifecycle } = lifecycleFor([
      { header: { id: 'newer', createdAt: new Date('2026-11-26T10:00:00+08:00').getTime() } },
      { header: { id: 'oldest', createdAt: new Date('2026-11-19T10:00:00+08:00').getTime(), cwd: '/work/oldest' } },
      { header: { id: 'marked-now', createdAt: new Date('2026-11-18T10:00:00+08:00').getTime() } },
      { header: { id: 'marked-earlier', createdAt: new Date('2026-11-17T10:00:00+08:00').getTime() } },
      { header: { id: 'archived', createdAt: new Date('2026-11-16T10:00:00+08:00').getTime() } },
      { header: { id: 'child', createdAt: new Date('2026-11-15T10:00:00+08:00').getTime(), parentSession: 'oldest' } },
      { header: { id: 'delegated', createdAt: new Date('2026-11-14T10:00:00+08:00').getTime(), origin: 'subagent' } },
      { header: { id: 'nested', createdAt: new Date('2026-11-13T10:00:00+08:00').getTime(), delegationDepth: 1 } },
    ], { archived: ['archived'], titles: { newer: 'Today plan', oldest: 'Oldest notes' } })

    const queue = await lifecycle.idleReviewQueue(new AbortController().signal)
    expect(queue.pending).toBe(3)
    expect(queue.sessions.map(session => session.id)).toEqual(['marked-earlier', 'oldest', 'newer'])
    expect(queue.sessions.find(session => session.id === 'oldest')).toEqual({
      id: 'oldest', createdAt: new Date('2026-11-19T10:00:00+08:00').getTime(), cwd: '/work/oldest', title: 'Oldest notes',
    })
    expect(queue.sessions.find(session => session.id === 'newer')?.title).toBe('Today plan')
    expect(queue.sessions.find(session => session.id === 'marked-earlier')?.title).toBeUndefined()
  })

  it('counts the whole backlog but caps the listed rows', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T12:00:00+08:00'))
    dataRoot()
    const records = Array.from({ length: 25 }, (_, index) => ({ header: { id: `session-${index}`, createdAt: index } }))
    const { lifecycle } = lifecycleFor(records)

    const queue = await lifecycle.idleReviewQueue()
    expect(queue.pending).toBe(25)
    expect(queue.sessions).toHaveLength(20)
    expect(queue.sessions[0]?.id).toBe('session-0')
    expect(queue.sessions.at(-1)?.id).toBe('session-19')
  })

  it('reports an explicit request for a missing Session as unavailable', async () => {
    dataRoot()
    const { lifecycle } = lifecycleFor([])
    const signal = new AbortController().signal
    await expect(lifecycle.reviewSessionNow('', signal)).resolves.toEqual({ outcome: 'skipped', reason: 'unavailable' })
    await expect(lifecycle.reviewSessionNow('unknown', signal)).resolves.toEqual({ outcome: 'skipped', reason: 'unavailable' })
  })

  it('serves an empty queue when the Session query service is absent', async () => {
    dataRoot()
    const host = { get: () => undefined, agents: { get: () => undefined } } as unknown as HostContextShape
    const lifecycle = new MnemonLifecycle(host, {} as never, resolveConfig({ idleReview: { at: '00:00' } }))
    await expect(lifecycle.idleReviewQueue()).resolves.toEqual({ pending: 0, sessions: [] })
  })
})
