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

/** Returns the next occurrence strictly after now, in Host local time. */
export function nextOccurrence(value: string, now: Date): Date {
  const time = parseClockTime(value)
  const today = at(time, now.getFullYear(), now.getMonth(), now.getDate())
  return today.getTime() > now.getTime() ? today : at(time, now.getFullYear(), now.getMonth(), now.getDate() + 1)
}
