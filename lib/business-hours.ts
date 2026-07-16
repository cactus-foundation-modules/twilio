// Opening hours for a phone number: one window per weekday, evaluated in the
// site's configured timezone. Outside the window the number does not ring at
// all - the caller goes straight to voicemail (or is rejected, if voicemail is
// off).
//
// Deliberately free of database imports so the admin form can share the type,
// the validator and the default schedule. The timezone lookup that feeds
// isOpenAt lives in forwarding.ts, which is server-only.

export type BusinessHoursDay = {
  /** 0 = Sunday, 6 = Saturday - matches Date.getDay() and the picker order. */
  day: number
  /** Closed all day. open/close are kept so toggling back restores the window. */
  closed: boolean
  /** "HH:MM", 24-hour, in the site's timezone. */
  open: string
  close: string
}

export type BusinessHours = BusinessHoursDay[]

// Bounds on how long the forward-to number rings before voicemail takes over.
// Twilio's <Dial timeout> allows up to 600s, but a caller listening to two
// minutes of ringing has already given up, and under 5s never even rings.
export const MIN_RING_TIMEOUT = 5
export const MAX_RING_TIMEOUT = 120

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value)
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

// Parses whatever came off the wire or out of the jsonb column. Returns null on
// anything malformed so callers can reject the save rather than store rubbish
// that would silently mis-route calls later.
export function parseBusinessHours(value: unknown): BusinessHours | null {
  if (!Array.isArray(value)) return null
  const days: BusinessHours = []
  const seen = new Set<number>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const e = entry as Record<string, unknown>
    const day = e.day
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) return null
    if (seen.has(day)) return null
    seen.add(day)
    if (typeof e.closed !== 'boolean') return null
    if (typeof e.open !== 'string' || !isValidTime(e.open)) return null
    if (typeof e.close !== 'string' || !isValidTime(e.close)) return null
    days.push({ day, closed: e.closed, open: e.open, close: e.close })
  }
  return days
}

// Mon-Fri 09:00-17:00, weekend off - what the admin form starts from when
// opening hours are switched on for the first time.
export function defaultBusinessHours(): BusinessHours {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    closed: day === 0 || day === 6,
    open: '09:00',
    close: '17:00',
  }))
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Weekday and minute-of-day as they read on a clock in `timezone`. An unknown
// timezone falls back to UTC rather than throwing mid-call - a wrong hour is
// recoverable, a 500 on the voice webhook drops the caller.
function clockIn(timezone: string, at: Date): { weekday: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      // h23 keeps midnight at 00, not the 24 some ICU builds emit for hour12:false.
      hourCycle: 'h23',
    }).formatToParts(at)
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at)
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = WEEKDAYS.indexOf(get('weekday'))
  const minutes = Number(get('hour')) * 60 + Number(get('minute'))
  return { weekday: weekday === -1 ? 0 : weekday, minutes }
}

// Is `at` inside the schedule? Windows where close is earlier than open run
// overnight and belong to the day they start on, so a Monday 18:00-02:00 window
// still counts at 01:00 on the Tuesday.
export function isOpenAt(hours: BusinessHours, timezone: string, at: Date): boolean {
  // No schedule set means no restriction - the number is available around the
  // clock, which is how every rule behaved before opening hours existed.
  if (hours.length === 0) return true

  const { weekday, minutes } = clockIn(timezone, at)
  const today = hours.find((h) => h.day === weekday)
  const yesterday = hours.find((h) => h.day === (weekday + 6) % 7)

  if (today && !today.closed) {
    const open = toMinutes(today.open)
    const close = toMinutes(today.close)
    // Same-day window. open == close is a zero-length window: use the Closed
    // toggle for a day off, not a 09:00-09:00 window.
    if (close > open && minutes >= open && minutes < close) return true
    // Overnight window, before midnight.
    if (close < open && minutes >= open) return true
  }

  if (yesterday && !yesterday.closed) {
    const open = toMinutes(yesterday.open)
    const close = toMinutes(yesterday.close)
    // Overnight window started yesterday, still running after midnight.
    if (close < open && minutes < close) return true
  }

  // A day missing from an otherwise-populated schedule is treated as
  // unrestricted rather than closed: an absent rule should never be the thing
  // that stops a call getting through. The admin form always writes all seven.
  if (!today) return true

  return false
}
