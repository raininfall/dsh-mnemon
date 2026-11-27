import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviewMarkerStore } from '../src/host/review-marker-store.ts'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-marker-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('review marker store', () => {
  it('returns an empty record when the file is missing', () => {
    expect(new ReviewMarkerStore(temp()).load()).toEqual({})
  })

  it('round-trips a marker for one session', () => {
    const store = new ReviewMarkerStore(temp())
    store.record('session-1', 'reviewed', 1_795_276_800_000)
    expect(store.load()).toEqual({ 'session-1': { at: 1_795_276_800_000, outcome: 'reviewed' } })
  })

  it('merges sessions without dropping earlier markers', () => {
    const store = new ReviewMarkerStore(temp())
    store.record('session-1', 'reviewed', 1)
    store.record('session-2', 'skipped', 2)
    store.record('session-1', 'skipped', 3)
    expect(store.load()).toEqual({ 'session-1': { at: 3, outcome: 'skipped' }, 'session-2': { at: 2, outcome: 'skipped' } })
  })

  it('clears one session without dropping the others', () => {
    const store = new ReviewMarkerStore(temp())
    store.record('session-1', 'reviewed', 1)
    store.record('session-2', 'skipped', 2)
    store.clear('session-1')
    expect(store.load()).toEqual({ 'session-2': { at: 2, outcome: 'skipped' } })
  })

  it('creates no marker file when the session has no marker', () => {
    const root = temp()
    new ReviewMarkerStore(root).clear('session-1')
    expect(() => readFileSync(join(root, 'state', 'review-markers.json'))).toThrow()
  })

  it('rejects an empty session id', () => {
    expect(() => new ReviewMarkerStore(temp()).clear('')).toThrow('review marker needs a session id')
  })

  it('treats a corrupt or version-mismatched file as empty instead of blocking markers', () => {
    const root = temp()
    const store = new ReviewMarkerStore(root)
    store.record('session-1', 'reviewed', 1)
    const file = join(root, 'state', 'review-markers.json')
    writeFileSync(file, 'not json')
    expect(store.load()).toEqual({})
    store.record('session-2', 'skipped', 2)
    expect(store.load()).toEqual({ 'session-2': { at: 2, outcome: 'skipped' } })
    writeFileSync(file, '{"version":2,"markers":{"session-9":{"at":1,"outcome":"reviewed"}}}')
    expect(store.load()).toEqual({})
  })

  it('drops entries with a malformed timestamp or outcome', () => {
    const root = temp()
    const store = new ReviewMarkerStore(root)
    mkdirMarkerFile(root, {
      'session-1': { at: 1, outcome: 'reviewed' },
      'session-2': { at: 'nope', outcome: 'reviewed' },
      'session-3': { at: 2, outcome: 'guessed' },
      'session-4': { at: -5, outcome: 'skipped' },
    })
    expect(store.load()).toEqual({ 'session-1': { at: 1, outcome: 'reviewed' } })
  })

  it('writes a small file without following symlinks', () => {
    const root = temp()
    const store = new ReviewMarkerStore(root)
    store.record('session-1', 'reviewed', 42)
    const text = readFileSync(join(root, 'state', 'review-markers.json'), 'utf8')
    expect(text).toContain('"session-1"')
    expect(Buffer.byteLength(text)).toBeLessThan(1024)
  })
})

function mkdirMarkerFile(root: string, markers: Record<string, unknown>): void {
  const directory = join(root, 'state')
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'review-markers.json'), JSON.stringify({ version: 1, markers }))
}
