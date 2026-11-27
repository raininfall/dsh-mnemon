import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/host/config.ts'
import { createPluginMessage } from '../src/host/plugin-message.ts'
import { ReviewMarkerStore } from '../src/host/review-marker-store.ts'
import { cleanupLifecycleDirectories, completeDurableTurns, directories, fixture, userMessage } from './fixtures/lifecycle.ts'
import { afterAll } from 'vitest'

afterAll(cleanupLifecycleDirectories)
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('review sidebar markers', () => {
  it('records a skipped marker when the daily occurrence finds content below the admission bar', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 0))
    const root = mkdtempSync(join(tmpdir(), 'dsh-mnemon-marker-life-'))
    vi.stubEnv('MNEMON_DATA_DIR', root)
    const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }), { directory: mkdtempSync(join(directories, 'marker-skip-')) })
    try {
      await value.preStep([userMessage('hi')], 1)
      await value.turnStopping(1)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(value.coordinator.review).not.toHaveBeenCalled()
      expect(new ReviewMarkerStore(root).load()['session-1']).toMatchObject({ outcome: 'skipped' })
    } finally { value.stop() }
  })

  it('records a reviewed marker after a successful automatic review', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 0))
    const root = mkdtempSync(join(tmpdir(), 'dsh-mnemon-marker-life-'))
    vi.stubEnv('MNEMON_DATA_DIR', root)
    const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }), { directory: mkdtempSync(join(directories, 'marker-run-')) })
    try {
      await completeDurableTurns(value)
      expect(value.coordinator.review).toHaveBeenCalledTimes(1)
      expect(new ReviewMarkerStore(root).load()['session-1']).toMatchObject({ outcome: 'reviewed' })
    } finally { value.stop() }
  })

  it('clears the marker when the reviewed session receives a real user message', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 0))
    const root = mkdtempSync(join(tmpdir(), 'dsh-mnemon-marker-life-'))
    vi.stubEnv('MNEMON_DATA_DIR', root)
    const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }), { directory: mkdtempSync(join(directories, 'marker-clear-')) })
    try {
      await completeDurableTurns(value)
      expect(new ReviewMarkerStore(root).load()['session-1']).toMatchObject({ outcome: 'reviewed' })
      value.events.push({ type: 'user/message', seq: value.events.length, data: { ...userMessage('Next step') } })
      value.agentListeners.get('session/event')?.(value.agent.session, value.events.at(-1))
      expect(new ReviewMarkerStore(root).load()['session-1']).toBeUndefined()
    } finally { value.stop() }
  })

  it('keeps the marker when only an injected mnemon message arrives', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 0))
    const root = mkdtempSync(join(tmpdir(), 'dsh-mnemon-marker-life-'))
    vi.stubEnv('MNEMON_DATA_DIR', root)
    const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }), { directory: mkdtempSync(join(directories, 'marker-inject-')) })
    try {
      await completeDurableTurns(value)
      value.events.push({ type: 'user/message', seq: value.events.length, data: { ...createPluginMessage('Pinned memory', 'instructions') } })
      value.agentListeners.get('session/event')?.(value.agent.session, value.events.at(-1))
      expect(new ReviewMarkerStore(root).load()['session-1']).toMatchObject({ outcome: 'reviewed' })
    } finally { value.stop() }
  })

  it('records no marker when the automatic review fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 0))
    const root = mkdtempSync(join(tmpdir(), 'dsh-mnemon-marker-life-'))
    vi.stubEnv('MNEMON_DATA_DIR', root)
    const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }), { directory: mkdtempSync(join(directories, 'marker-fail-')) })
    vi.mocked(value.coordinator.review).mockRejectedValueOnce(new Error('TeamError: reviewer failed'))
    try {
      await completeDurableTurns(value)
      expect(value.coordinator.review).toHaveBeenCalledTimes(1)
      expect(new ReviewMarkerStore(root).load()['session-1']).toBeUndefined()
    } finally { value.stop() }
  })
})
