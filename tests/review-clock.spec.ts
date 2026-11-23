import { describe, expect, it } from 'vitest'
import { nextOccurrence, parseClockTime, previousOccurrence, seedHandledOccurrence } from '../src/host/review-clock.ts'

const local = (y: number, m: number, d: number, h: number, min: number): Date => new Date(y, m, d, h, min, 0, 0)

describe('review clock', () => {
  it('parses 24-hour local times and rejects everything else', () => {
    expect(parseClockTime('00:00')).toEqual({ hours: 0, minutes: 0 })
    expect(parseClockTime('23:59')).toEqual({ hours: 23, minutes: 59 })
    for (const value of ['24:00', '7:30', '07:60', '0730', '', ' 07:30', '07:30 ']) {
      expect(() => parseClockTime(value)).toThrow('HH:MM')
    }
  })

  it('finds the next occurrence strictly after now', () => {
    expect(nextOccurrence('00:00', local(2026, 0, 1, 23, 59)).getTime()).toBe(local(2026, 0, 2, 0, 0).getTime())
    expect(nextOccurrence('00:00', local(2026, 0, 2, 0, 0)).getTime()).toBe(local(2026, 0, 3, 0, 0).getTime())
    expect(nextOccurrence('23:30', local(2026, 0, 1, 23, 29)).getTime()).toBe(local(2026, 0, 1, 23, 30).getTime())
    expect(nextOccurrence('23:30', local(2026, 0, 1, 23, 30)).getTime()).toBe(local(2026, 0, 2, 23, 30).getTime())
  })

  it('finds the most recent occurrence at or before now and crosses boundaries', () => {
    expect(nextOccurrence('00:00', local(2026, 11, 31, 23, 59)).getTime()).toBe(local(2027, 0, 1, 0, 0).getTime())
    expect(previousOccurrence('00:00', local(2026, 0, 1, 0, 0)).getTime()).toBe(local(2026, 0, 1, 0, 0).getTime())
    expect(previousOccurrence('00:00', local(2026, 0, 1, 0, 1)).getTime()).toBe(local(2026, 0, 1, 0, 0).getTime())
    expect(previousOccurrence('00:00', local(2025, 11, 31, 23, 59)).getTime()).toBe(local(2025, 11, 31, 0, 0).getTime())
  })

  it('seeds a fresh clock from the Session creation time', () => {
    const now = local(2026, 0, 2, 9, 0)
    const due = local(2026, 0, 2, 0, 0).getTime()
    const previous = local(2026, 0, 1, 0, 0).getTime()
    expect(seedHandledOccurrence('00:00', now, local(2026, 0, 1, 12, 0).getTime())).toBe(previous)
    expect(seedHandledOccurrence('00:00', now, due)).toBe(previous)
    expect(seedHandledOccurrence('00:00', now, due + 1)).toBe(due)
    expect(seedHandledOccurrence('00:00', now, now.getTime())).toBe(due)
    expect(seedHandledOccurrence('00:00', now, undefined)).toBe(previous)
  })

  it('returns local wall-clock instants across DST transitions without throwing', () => {
    const spring = local(2026, 2, 8, 1, 0)
    const next = nextOccurrence('02:30', spring)
    expect(next.getTime()).toBeGreaterThan(spring.getTime())
    expect(next.getDate()).toBe(8)
    const fall = local(2026, 10, 1, 0, 0)
    expect(previousOccurrence('01:30', fall).getTime()).toBeLessThanOrEqual(fall.getTime())
  })
})
