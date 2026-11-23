export interface ClockTime {
  readonly hours: number
  readonly minutes: number
}

const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u

/** Parses a 24-hour local wall-clock time; throws on any other form. */
export function parseClockTime(value: string): ClockTime {
  const match = CLOCK_TIME.exec(value)
  if (match === null) throw new Error(`idleReview.at must be HH:MM in 24-hour local time, received ${JSON.stringify(value)}`)
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

function at(time: ClockTime, year: number, month: number, day: number): Date {
  return new Date(year, month, day, time.hours, time.minutes, 0, 0)
}

/** Returns the most recent occurrence at or before now, in Host local time. */
export function previousOccurrence(value: string, now: Date): Date {
  const time = parseClockTime(value)
  const today = at(time, now.getFullYear(), now.getMonth(), now.getDate())
  return today.getTime() <= now.getTime() ? today : at(time, now.getFullYear(), now.getMonth(), now.getDate() - 1)
}

/**
 * Returns the occurrence one day before the most recent one at or before now.
 * A Session that already existed at the most recent occurrence seeds to this
 * instant, so it still treats that occurrence as unhandled and reviews it once.
 */
export function dayBeforeOccurrence(value: string, now: Date): Date {
  const time = parseClockTime(value)
  const due = previousOccurrence(value, now)
  return at(time, due.getFullYear(), due.getMonth(), due.getDate() - 1)
}

/**
 * Seeds the handled occurrence for a Session that has no stored clock position.
 * A Session created after the most recent occurrence starts with it handled and
 * waits for the next one; a Session that already existed seeds one occurrence
 * back so its first eligible turn catches up the occurrence it missed. A missing
 * creation time keeps that catch-up, since the Session's age is unknown.
 *
 * @param value - Daily local wall-clock time in HH:MM.
 * @param now - Current Host local time.
 * @param createdAt - Session creation instant in Unix epoch milliseconds.
 * @returns The epoch milliseconds to store as the handled occurrence.
 */
export function seedHandledOccurrence(value: string, now: Date, createdAt: number | undefined): number {
  const due = previousOccurrence(value, now)
  if (createdAt !== undefined && createdAt > due.getTime()) return due.getTime()
  return dayBeforeOccurrence(value, now).getTime()
}

/** Returns the next occurrence strictly after now, in Host local time. */
export function nextOccurrence(value: string, now: Date): Date {
  const time = parseClockTime(value)
  const today = at(time, now.getFullYear(), now.getMonth(), now.getDate())
  return today.getTime() > now.getTime() ? today : at(time, now.getFullYear(), now.getMonth(), now.getDate() + 1)
}
