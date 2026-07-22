// The holiday importer reads two third-party feeds with different shapes, and
// a parsing slip here shows up as a phone line closed on the wrong day - or
// worse, silently open on Christmas. The fetch is stubbed: what is under test
// is the reading of the payloads, not anyone else's uptime.
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  fetchHolidayWindow,
  fetchHolidays,
  findHolidayRegion,
  oneYearOn,
  todayIn,
  HOLIDAY_REGIONS,
} from './holidays'

function stubJson(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => payload }) as unknown as Response)
  )
}

// Nager answers per year, so the window fetch makes one request per calendar
// year it straddles. This stub answers each from a year-keyed map.
function stubNagerByYear(byYear: Record<number, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const year = Number(url.match(/PublicHolidays\/(\d{4})\//)?.[1])
      return { ok: true, status: 200, json: async () => byYear[year] ?? [] } as unknown as Response
    })
  )
}

const region = (id: string) => {
  const found = findHolidayRegion(id)
  if (!found) throw new Error(`no such region: ${id}`)
  return found
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HOLIDAY_REGIONS', () => {
  it('covers the five countries the importer offers, with unique ids', () => {
    expect(HOLIDAY_REGIONS.map((r) => r.id)).toEqual([
      'england-and-wales',
      'scotland',
      'northern-ireland',
      'ireland',
      'united-states',
    ])
    expect(new Set(HOLIDAY_REGIONS.map((r) => r.id)).size).toBe(HOLIDAY_REGIONS.length)
  })

  it('finds a region by id and refuses an unknown one', () => {
    expect(findHolidayRegion('scotland')?.source).toBe('gov.uk')
    expect(findHolidayRegion('narnia')).toBeNull()
  })
})

describe('fetchHolidays from gov.uk', () => {
  // The feed carries every division and about ten years in one document, so
  // picking the right slice out of it is the whole job.
  const feed = {
    'england-and-wales': {
      events: [
        { title: 'New Year’s Day', date: '2026-01-01' },
        { title: 'Christmas Day', date: '2026-12-25' },
        { title: 'New Year’s Day', date: '2027-01-01' },
      ],
    },
    scotland: {
      events: [
        { title: 'St Andrew’s Day', date: '2026-11-30' },
        { title: 'New Year’s Day', date: '2026-01-01' },
      ],
    },
  }

  it('takes only the asked-for division and year, in date order', async () => {
    stubJson(feed)
    expect(await fetchHolidays(region('england-and-wales'), 2026)).toEqual([
      { date: '2026-01-01', name: 'New Year’s Day' },
      { date: '2026-12-25', name: 'Christmas Day' },
    ])
  })

  it('does not mix divisions up', async () => {
    stubJson(feed)
    const scots = await fetchHolidays(region('scotland'), 2026)
    expect(scots.map((h) => h.date)).toEqual(['2026-01-01', '2026-11-30'])
  })

  // gov.uk always publishes all three divisions, so one going missing means the
  // feed has changed shape rather than that Northern Ireland has cancelled
  // Christmas. Saying so beats returning an empty list the admin would read as
  // "no holidays that year".
  it('refuses a feed missing the division asked for', async () => {
    stubJson(feed)
    await expect(fetchHolidays(region('northern-ireland'), 2026)).rejects.toThrow(/unexpected shape/)
  })

  it('returns nothing for a year the feed does not reach', async () => {
    stubJson(feed)
    expect(await fetchHolidays(region('england-and-wales'), 2029)).toEqual([])
  })

  it('skips entries with a missing or malformed date', async () => {
    stubJson({
      'england-and-wales': {
        events: [
          { title: 'Good', date: '2026-05-04' },
          { title: 'No date' },
          { title: 'Wrong shape', date: '04/05/2026' },
        ],
      },
    })
    expect(await fetchHolidays(region('england-and-wales'), 2026)).toEqual([
      { date: '2026-05-04', name: 'Good' },
    ])
  })

  it('names an untitled entry rather than showing a blank row', async () => {
    stubJson({ 'england-and-wales': { events: [{ title: '  ', date: '2026-05-04' }] } })
    expect((await fetchHolidays(region('england-and-wales'), 2026))[0]!.name).toBe('Bank holiday')
  })

  it('throws when the feed is not the shape it should be', async () => {
    stubJson({ 'england-and-wales': { events: 'nope' } })
    await expect(fetchHolidays(region('england-and-wales'), 2026)).rejects.toThrow(/unexpected shape/)
  })

  it('throws with the status when the source is down', async () => {
    stubJson(null, false, 503)
    await expect(fetchHolidays(region('england-and-wales'), 2026)).rejects.toThrow(/HTTP 503/)
  })
})

describe('fetchHolidays from Nager', () => {
  it('prefers the local name and sorts by date', async () => {
    stubJson([
      { date: '2026-03-17', localName: 'Lá Fhéile Pádraig', name: "Saint Patrick's Day", global: true },
      { date: '2026-01-01', localName: 'Lá Caille', name: "New Year's Day", global: true },
    ])
    expect(await fetchHolidays(region('ireland'), 2026)).toEqual([
      { date: '2026-01-01', name: 'Lá Caille' },
      { date: '2026-03-17', name: 'Lá Fhéile Pádraig' },
    ])
  })

  // A state-only holiday would close a phone line for a business nowhere near
  // that state, so regional days are left out of the offer.
  it('leaves out days that are not nationwide', async () => {
    stubJson([
      { date: '2026-01-01', name: "New Year's Day", global: true },
      { date: '2026-03-31', name: 'Cesar Chavez Day', global: false, counties: ['US-CA'] },
      { date: '2026-07-04', name: 'Independence Day' },
    ])
    const us = await fetchHolidays(region('united-states'), 2026)
    expect(us.map((h) => h.date)).toEqual(['2026-01-01', '2026-07-04'])
  })

  it('keeps one entry per date', async () => {
    stubJson([
      { date: '2026-12-25', localName: 'Christmas Day', global: true },
      { date: '2026-12-25', localName: 'Christmas Day (again)', global: true },
    ])
    expect(await fetchHolidays(region('united-states'), 2026)).toEqual([
      { date: '2026-12-25', name: 'Christmas Day' },
    ])
  })

  it('falls back to a generic name when both names are empty', async () => {
    stubJson([{ date: '2026-12-25', localName: '', name: '', global: true }])
    expect((await fetchHolidays(region('ireland'), 2026))[0]!.name).toBe('Public holiday')
  })

  it('throws when the payload is not a list', async () => {
    stubJson({ message: 'nope' })
    await expect(fetchHolidays(region('ireland'), 2026)).rejects.toThrow(/unexpected shape/)
  })
})

describe('todayIn', () => {
  it('reads the calendar date in the given timezone', () => {
    // 23:30 UTC is already tomorrow in Sydney and still yesterday evening in
    // New York. (London is no use as the "behind" example - in July it is BST,
    // so 23:30 UTC is already half past midnight there.)
    const at = new Date('2026-07-22T23:30:00Z')
    expect(todayIn('Australia/Sydney', at)).toBe('2026-07-23')
    expect(todayIn('America/New_York', at)).toBe('2026-07-22')
    expect(todayIn('Europe/London', at)).toBe('2026-07-23')
  })

  it('falls back to UTC rather than throwing on an unknown timezone', () => {
    expect(todayIn('Mars/Olympus_Mons', new Date('2026-07-22T12:00:00Z'))).toBe('2026-07-22')
  })
})

describe('oneYearOn', () => {
  it('lands on the same date a year later', () => {
    expect(oneYearOn('2026-07-22')).toBe('2027-07-22')
    expect(oneYearOn('2026-01-01')).toBe('2027-01-01')
  })

  // 29 February has no anniversary, so the bound rolls to 1 March. It is an
  // exclusive end, so a leap-day start still covers a full twelve months.
  it('rolls a leap day forward rather than producing a date that does not exist', () => {
    expect(oneYearOn('2028-02-29')).toBe('2029-03-01')
  })
})

describe('fetchHolidayWindow', () => {
  const govUkFeed = {
    'england-and-wales': {
      events: [
        { title: 'Early May bank holiday', date: '2026-05-04' },
        { title: 'Christmas Day', date: '2026-12-25' },
        { title: 'Boxing Day', date: '2026-12-28' },
        { title: 'New Year’s Day', date: '2027-01-01' },
        { title: 'Good Friday', date: '2027-03-26' },
        { title: 'Christmas Day', date: '2027-12-27' },
      ],
    },
  }

  // The whole point of the change: importing in October must reach next
  // spring, and must not offer dates that have already been.
  it('spans two calendar years from the day it is run', async () => {
    stubJson(govUkFeed)
    const { holidays, from, to } = await fetchHolidayWindow(region('england-and-wales'), '2026-10-01')
    expect(from).toBe('2026-10-01')
    expect(to).toBe('2027-10-01')
    expect(holidays.map((h) => h.date)).toEqual([
      '2026-12-25',
      '2026-12-28',
      '2027-01-01',
      '2027-03-26',
    ])
  })

  it('leaves out dates before the start of the window', async () => {
    stubJson(govUkFeed)
    const { holidays } = await fetchHolidayWindow(region('england-and-wales'), '2026-06-01')
    expect(holidays.map((h) => h.date)).not.toContain('2026-05-04')
  })

  // The end of the window is exclusive: a holiday exactly a year out belongs
  // to next year's import, not this one, or it would be offered twice.
  it('excludes a holiday falling exactly on the end of the window', async () => {
    stubJson({ 'england-and-wales': { events: [{ title: 'Edge', date: '2027-07-22' }] } })
    const { holidays } = await fetchHolidayWindow(region('england-and-wales'), '2026-07-22')
    expect(holidays).toEqual([])
  })

  it('includes a holiday falling on the first day of the window', async () => {
    stubJson({ 'england-and-wales': { events: [{ title: 'New Year’s Day', date: '2027-01-01' }] } })
    const { holidays } = await fetchHolidayWindow(region('england-and-wales'), '2027-01-01')
    expect(holidays.map((h) => h.date)).toEqual(['2027-01-01'])
  })

  it('merges both years for a per-year source', async () => {
    stubNagerByYear({
      2026: [{ date: '2026-12-25', localName: 'Christmas Day', global: true }],
      2027: [{ date: '2027-03-17', localName: 'Lá Fhéile Pádraig', global: true }],
    })
    const { holidays } = await fetchHolidayWindow(region('ireland'), '2026-10-01')
    expect(holidays.map((h) => h.date)).toEqual(['2026-12-25', '2027-03-17'])
  })

  it('keeps one entry per date across the two years', async () => {
    stubNagerByYear({
      2026: [{ date: '2026-12-25', localName: 'Christmas Day', global: true }],
      2027: [{ date: '2026-12-25', localName: 'Christmas Day (again)', global: true }],
    })
    const { holidays } = await fetchHolidayWindow(region('united-states'), '2026-10-01')
    expect(holidays).toEqual([{ date: '2026-12-25', name: 'Christmas Day' }])
  })

  it('fails the whole window rather than half of it when a source is down', async () => {
    stubJson(null, false, 503)
    await expect(fetchHolidayWindow(region('ireland'), '2026-10-01')).rejects.toThrow(/HTTP 503/)
  })
})
