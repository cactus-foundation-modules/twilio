// Opening-hours evaluation decides whether an inbound call rings a phone or
// goes to voicemail, and it is all off-by-one territory: timezones, midnight,
// overnight windows. Cheap to get subtly wrong, and the only symptom is a
// customer's phone silently not ringing.
import { describe, it, expect } from 'vitest'
import {
  isHolidayOn,
  isOpenAt,
  parseBusinessHours,
  parseHolidayDates,
  defaultBusinessHours,
  type BusinessHours,
} from './business-hours'

// 2026-07-13 is a Monday.
const mondayAt = (time: string) => new Date(`2026-07-13T${time}:00Z`)

const nineToFive: BusinessHours = [
  { day: 1, closed: false, open: '09:00', close: '17:00' },
]

describe('isOpenAt', () => {
  it('treats an empty schedule as always open', () => {
    expect(isOpenAt([], 'Europe/London', mondayAt('03:00'))).toBe(true)
  })

  it('is open inside the window and shut outside it', () => {
    expect(isOpenAt(nineToFive, 'UTC', mondayAt('08:59'))).toBe(false)
    expect(isOpenAt(nineToFive, 'UTC', mondayAt('09:00'))).toBe(true)
    expect(isOpenAt(nineToFive, 'UTC', mondayAt('16:59'))).toBe(true)
    // Closing time is exclusive: at 17:00 sharp the phone stops ringing.
    expect(isOpenAt(nineToFive, 'UTC', mondayAt('17:00'))).toBe(false)
  })

  it('reads the clock in the site timezone, not UTC', () => {
    // 08:30 UTC is 09:30 British Summer Time - open in London, shut in UTC.
    expect(isOpenAt(nineToFive, 'Europe/London', mondayAt('08:30'))).toBe(true)
    expect(isOpenAt(nineToFive, 'UTC', mondayAt('08:30'))).toBe(false)
  })

  it('falls back to UTC rather than throwing on an unknown timezone', () => {
    expect(isOpenAt(nineToFive, 'Mars/Olympus_Mons', mondayAt('12:00'))).toBe(true)
    expect(isOpenAt(nineToFive, 'Mars/Olympus_Mons', mondayAt('20:00'))).toBe(false)
  })

  it('honours a day marked closed', () => {
    const closed: BusinessHours = [{ day: 1, closed: true, open: '09:00', close: '17:00' }]
    expect(isOpenAt(closed, 'UTC', mondayAt('12:00'))).toBe(false)
  })

  it('leaves a day missing from the schedule unrestricted', () => {
    // An absent rule should never be the thing that stops a call getting
    // through, so a day with no entry rings around the clock. The admin form
    // always writes all seven, so this is the defensive path.
    const tuesdayOnly: BusinessHours = [{ day: 2, closed: false, open: '09:00', close: '17:00' }]
    expect(isOpenAt(tuesdayOnly, 'UTC', mondayAt('03:00'))).toBe(true)
  })

  it('runs an overnight window through midnight into the next day', () => {
    // Monday 18:00 - 02:00. Open late Monday, still open early Tuesday, shut in
    // the gap between.
    const lateShift: BusinessHours = [
      { day: 1, closed: false, open: '18:00', close: '02:00' },
      { day: 2, closed: true, open: '09:00', close: '17:00' },
    ]
    expect(isOpenAt(lateShift, 'UTC', mondayAt('17:59'))).toBe(false)
    expect(isOpenAt(lateShift, 'UTC', mondayAt('18:00'))).toBe(true)
    expect(isOpenAt(lateShift, 'UTC', mondayAt('23:59'))).toBe(true)
    // Tuesday 01:00 - still inside Monday's overnight window.
    expect(isOpenAt(lateShift, 'UTC', new Date('2026-07-14T01:00:00Z'))).toBe(true)
    // Tuesday 02:00 - the window has closed, and Tuesday itself is shut.
    expect(isOpenAt(lateShift, 'UTC', new Date('2026-07-14T02:00:00Z'))).toBe(false)
  })

  it('does not spill an overnight window out of a closed day', () => {
    const closedLateShift: BusinessHours = [
      { day: 1, closed: true, open: '18:00', close: '02:00' },
      { day: 2, closed: true, open: '09:00', close: '17:00' },
    ]
    expect(isOpenAt(closedLateShift, 'UTC', new Date('2026-07-14T01:00:00Z'))).toBe(false)
  })

  it('treats a zero-length window as shut', () => {
    const zero: BusinessHours = [{ day: 1, closed: false, open: '09:00', close: '09:00' }]
    expect(isOpenAt(zero, 'UTC', mondayAt('09:00'))).toBe(false)
  })

  it('handles midnight boundaries', () => {
    const allDay: BusinessHours = [{ day: 1, closed: false, open: '00:00', close: '23:59' }]
    expect(isOpenAt(allDay, 'UTC', mondayAt('00:00'))).toBe(true)
  })

  it('opens weekdays and shuts weekends by default', () => {
    const hours = defaultBusinessHours()
    // Monday midday open, Sunday midday shut.
    expect(isOpenAt(hours, 'UTC', mondayAt('12:00'))).toBe(true)
    expect(isOpenAt(hours, 'UTC', new Date('2026-07-12T12:00:00Z'))).toBe(false)
  })
})

describe('parseBusinessHours', () => {
  it('accepts a well-formed schedule and the empty case', () => {
    expect(parseBusinessHours([])).toEqual([])
    expect(parseBusinessHours(nineToFive)).toEqual(nineToFive)
    expect(parseBusinessHours(defaultBusinessHours())).toHaveLength(7)
  })

  it('rejects anything that is not an array of day entries', () => {
    expect(parseBusinessHours(null)).toBeNull()
    expect(parseBusinessHours('09:00')).toBeNull()
    expect(parseBusinessHours({ day: 1 })).toBeNull()
    expect(parseBusinessHours([null])).toBeNull()
  })

  it('rejects out-of-range or duplicated days', () => {
    expect(parseBusinessHours([{ day: 7, closed: false, open: '09:00', close: '17:00' }])).toBeNull()
    expect(parseBusinessHours([{ day: -1, closed: false, open: '09:00', close: '17:00' }])).toBeNull()
    expect(parseBusinessHours([{ day: 1.5, closed: false, open: '09:00', close: '17:00' }])).toBeNull()
    expect(
      parseBusinessHours([
        { day: 1, closed: false, open: '09:00', close: '17:00' },
        { day: 1, closed: false, open: '10:00', close: '18:00' },
      ])
    ).toBeNull()
  })

  it('rejects malformed times', () => {
    const bad = ['9:00', '', '24:00', '09:60', '09-00', 'nine']
    for (const open of bad) {
      expect(parseBusinessHours([{ day: 1, closed: false, open, close: '17:00' }])).toBeNull()
    }
    expect(parseBusinessHours([{ day: 1, closed: false, open: '09:00', close: '25:00' }])).toBeNull()
  })

  it('rejects a missing closed flag', () => {
    expect(parseBusinessHours([{ day: 1, open: '09:00', close: '17:00' }])).toBeNull()
  })
})

describe('parseHolidayDates', () => {
  it('accepts, sorts and deduplicates real dates', () => {
    expect(parseHolidayDates(['2026-12-26', '2026-12-25', '2026-12-25'])).toEqual([
      '2026-12-25',
      '2026-12-26',
    ])
    expect(parseHolidayDates([])).toEqual([])
  })

  it('rejects anything that is not a list of YYYY-MM-DD strings', () => {
    expect(parseHolidayDates('2026-12-25')).toBeNull()
    expect(parseHolidayDates([20261225])).toBeNull()
    expect(parseHolidayDates(['25-12-2026'])).toBeNull()
    expect(parseHolidayDates(['2026-13-01'])).toBeNull()
    expect(parseHolidayDates(['2026-12-32'])).toBeNull()
    expect(parseHolidayDates(['2026-12-25', ''])).toBeNull()
  })
})

describe('isHolidayOn', () => {
  it('matches the calendar date in the given timezone, not UTC', () => {
    // 23:30 UTC on the 24th is already Christmas Day in Sydney.
    const lateChristmasEve = new Date('2026-12-24T23:30:00Z')
    expect(isHolidayOn(['2026-12-25'], 'Australia/Sydney', lateChristmasEve)).toBe(true)
    expect(isHolidayOn(['2026-12-25'], 'Europe/London', lateChristmasEve)).toBe(false)
  })

  it('is never a holiday with no dates set', () => {
    expect(isHolidayOn([], 'UTC', new Date('2026-12-25T12:00:00Z'))).toBe(false)
  })
})
