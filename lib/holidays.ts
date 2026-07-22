// Public holiday lookup for the opening-hours holiday list, so an admin picks
// a country and a year instead of typing Easter out by hand every spring.
//
// Two sources, both free and unauthenticated:
//
//  - The UK divisions come from gov.uk's own bank holidays feed, which is the
//    authoritative list and covers roughly 2019-2028 in one document.
//  - Ireland and the United States come from Nager.Date, a public holiday API
//    with a year-and-country endpoint.
//
// Nothing here is stored: the dates fetched are shown to the admin, who picks
// which ones to add to the number's own holiday list. So a source being down,
// slow, or wrong about a bank holiday costs an import, never a saved setting.
const GOV_UK_URL = 'https://www.gov.uk/bank-holidays.json'
const NAGER_URL = 'https://date.nager.at/api/v3/PublicHolidays'

export type HolidayRegion = {
  id: string
  label: string
  source: 'gov.uk' | 'nager'
  /** gov.uk division key, or Nager two-letter country code. */
  key: string
}

export const HOLIDAY_REGIONS: HolidayRegion[] = [
  { id: 'england-and-wales', label: 'England and Wales', source: 'gov.uk', key: 'england-and-wales' },
  { id: 'scotland', label: 'Scotland', source: 'gov.uk', key: 'scotland' },
  { id: 'northern-ireland', label: 'Northern Ireland', source: 'gov.uk', key: 'northern-ireland' },
  { id: 'ireland', label: 'Republic of Ireland', source: 'nager', key: 'IE' },
  { id: 'united-states', label: 'United States', source: 'nager', key: 'US' },
]

export function findHolidayRegion(id: string): HolidayRegion | null {
  return HOLIDAY_REGIONS.find((r) => r.id === id) ?? null
}

export type Holiday = { date: string; name: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    // A day-old copy of a list that changes once a year is fine, and it keeps
    // a keen admin clicking Import repeatedly off someone else's server.
    next: { revalidate: 86_400 },
  })
  if (!res.ok) {
    throw new Error(`The holiday list could not be fetched (HTTP ${res.status}). Try again shortly.`)
  }
  return res.json()
}

async function fetchGovUk(division: string, year: number): Promise<Holiday[]> {
  const data = (await fetchJson(GOV_UK_URL)) as
    | Record<string, { events?: Array<{ title?: string; date?: string }> }>
    | null
  const events = data?.[division]?.events
  if (!Array.isArray(events)) {
    throw new Error('The gov.uk holiday list came back in an unexpected shape.')
  }
  return events
    .filter((e) => typeof e.date === 'string' && DATE_RE.test(e.date) && e.date.startsWith(`${year}-`))
    .map((e) => ({ date: e.date as string, name: e.title?.trim() || 'Bank holiday' }))
}

async function fetchNager(countryCode: string, year: number): Promise<Holiday[]> {
  const data = (await fetchJson(`${NAGER_URL}/${year}/${countryCode}`)) as
    | Array<{ date?: string; name?: string; localName?: string; global?: boolean }>
    | null
  if (!Array.isArray(data)) {
    throw new Error('The holiday list came back in an unexpected shape.')
  }
  return data
    .filter((e) => typeof e.date === 'string' && DATE_RE.test(e.date))
    // Regional-only days (a US state holiday, say) would close the phone line
    // for a business nowhere near that state, so only nationwide days are
    // offered. `global` is absent on some entries; absent is treated as
    // nationwide, which matches how the API documents the older records.
    .filter((e) => e.global !== false)
    .map((e) => ({ date: e.date as string, name: (e.localName || e.name || '').trim() || 'Public holiday' }))
}

function dedupeAndSort(holidays: Holiday[]): Holiday[] {
  const byDate = new Map<string, Holiday>()
  for (const h of holidays) {
    if (!byDate.has(h.date)) byDate.set(h.date, h)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

// The public holidays for one region and year, sorted, deduplicated by date
// (a date carrying two names keeps the first - the list is a set of closed
// days, not a calendar of events).
export async function fetchHolidays(region: HolidayRegion, year: number): Promise<Holiday[]> {
  const holidays =
    region.source === 'gov.uk'
      ? await fetchGovUk(region.key, year)
      : await fetchNager(region.key, year)
  return dedupeAndSort(holidays)
}

// Today's calendar date in a timezone, as "YYYY-MM-DD". en-CA formats that way
// directly; an unknown timezone falls back to UTC rather than throwing.
export function todayIn(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now)
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(now)
  }
}

// The same date a year later, as the exclusive end of the import window.
// Built through Date.UTC so the awkward one sorts itself out: a 29 February
// start has no anniversary, and Date.UTC rolls it to 1 March, which is the
// right exclusive bound either way.
export function oneYearOn(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y! + 1, m! - 1, d!)).toISOString().slice(0, 10)
}

export type HolidayWindow = { from: string; to: string; holidays: Holiday[] }

// Every public holiday in the twelve months starting today - which is what an
// admin setting up their opening hours actually wants. A calendar year is the
// wrong window for eleven months of the year: import in October and a whole
// calendar year's list is mostly dates that have already been.
//
// The window straddles two calendar years, so both are fetched. For gov.uk
// that is one document read twice (cached, so one request); for Nager it is
// two requests, run together. `from` is inclusive, `to` exclusive.
export async function fetchHolidayWindow(
  region: HolidayRegion,
  from: string
): Promise<HolidayWindow> {
  const to = oneYearOn(from)
  const firstYear = Number(from.slice(0, 4))

  const years = await Promise.all(
    [firstYear, firstYear + 1].map((year) =>
      region.source === 'gov.uk' ? fetchGovUk(region.key, year) : fetchNager(region.key, year)
    )
  )

  // ISO dates compare correctly as strings, so no parsing needed to window them.
  const inWindow = years.flat().filter((h) => h.date >= from && h.date < to)
  return { from, to, holidays: dedupeAndSort(inWindow) }
}
