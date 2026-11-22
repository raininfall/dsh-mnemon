import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviewClockStore } from '../src/host/review-clock-state.ts'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-clock-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('review clock state', () => {
  it('returns a first-run state when the file is missing', () => {
    expect(new ReviewClockStore(temp(), 'session-1').load()).toEqual({ version: 1, sessionId: 'session-1', lastHandledDueAt: null })
  })

  it('round-trips the last handled due and isolates sessions', () => {
    const directory = temp()
    const store = new ReviewClockStore(directory, 'session-1')
    store.save({ lastHandledDueAt: 1_700_000_000_000 })
    expect(store.load().lastHandledDueAt).toBe(1_700_000_000_000)
    expect(new ReviewClockStore(directory, 'session-2').load().lastHandledDueAt).toBeNull()
  })

  it('treats a corrupt or foreign file as first run instead of blocking review', () => {
    const store = new ReviewClockStore(temp(), 'session-1')
    store.save({ lastHandledDueAt: 1 })
    writeFileSync(store.path, '{"version":1,"sessionId":"other","lastHandledDueAt":5}')
    expect(store.load().lastHandledDueAt).toBeNull()
    writeFileSync(store.path, 'not json')
    expect(store.load().lastHandledDueAt).toBeNull()
  })

  it('writes a small file without following symlinks', () => {
    const store = new ReviewClockStore(temp(), 'session-1')
    store.save({ lastHandledDueAt: 42 })
    const text = readFileSync(store.path, 'utf8')
    expect(text).toContain('"lastHandledDueAt":42')
    expect(Buffer.byteLength(text)).toBeLessThan(256)
  })
})
