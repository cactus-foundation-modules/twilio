import type {
  ConversationListOptions,
  ConversationListPage,
  ConversationMessage,
  ConversationProvider,
  ConversationSummary,
  ConversationThread,
} from '@/lib/conversations/types'
import { getSiteNumbers, sendSiteSms, type SiteNumber } from './numbers'
import { isTwilioConfigured, listCallsForNumber, listMessagesForNumber } from './twilio'
import { recentVoicemails } from './voicemail-log'

// Calls, voicemail and texts, published as conversations.
//
// This module is shaped differently from the site's other messaging: only
// voicemail is written down here, and calls and texts are read live from
// Twilio, which keeps them. So a conversation below is assembled on demand out
// of three sources and grouped by the other person's number - every call, text
// and message from one number is one conversation with one human, which is what
// anybody looking at a merged list means by it.
//
// TWO THINGS THAT FOLLOW FROM THAT, AND MATTER:
//
//   The listing is BOUNDED AND CACHED. Twilio is a paid API over the network
//   and this is read from a merged list which may be drawn often. So it costs
//   at most a fixed number of requests per site number, over at most a fixed
//   number of numbers, and the assembled result is held for a few minutes. It
//   is meant to be read on an hourly tick, not on every page view.
//
//   There is no history beyond what Twilio still holds and what the account's
//   own retention allows. `since` narrows what is returned; it cannot reach
//   further back than the listing does.
//
// SERVER ONLY. The manifest entry sets serverOnly: this file carries the
// account credentials and must never reach a browser bundle.

/** How many of the site's numbers are read. Every extra number is three more
 *  Twilio requests, and a site with a dozen numbers would spend its whole
 *  budget here. Numbers beyond this are skipped and said so in the log. */
const MAX_NUMBERS = 4

/** How many calls and how many texts are read per number. */
const PER_NUMBER = 50

/** How long an assembled listing is reused. Long enough that a screen redrawn
 *  twice costs one round of requests, short enough that a text arriving is not
 *  invisible for the afternoon. */
const CACHE_TTL_MS = 5 * 60_000

const PREVIEW_CHARS = 160

type Entry = {
  id: string
  kind: 'call' | 'voicemail' | 'sms'
  /** The outside party's number, E.164 where Twilio gave us one. */
  party: string
  direction: 'in' | 'out'
  at: Date
  text: string
}

function preview(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat
}

/** A number in the form everything else compares on. Twilio hands back E.164
 *  for a real number and something like 'anonymous' for a withheld one, which
 *  is kept as it is rather than dropped: a withheld caller is still a call. */
function normaliseNumber(value: string): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return 'unknown'
  if (/^\+/.test(trimmed)) return trimmed.replace(/[^\d+]/g, '')
  return trimmed.toLowerCase()
}

function describeCall(direction: 'in' | 'out', status: string, seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  const length = seconds > 0
    ? minutes > 0 ? `${minutes} min ${rest} sec` : `${rest} sec`
    : null
  if (direction === 'in') {
    if (status === 'no-answer' || status === 'busy') return 'Missed call'
    if (status === 'failed' || status === 'canceled') return 'Call did not connect'
    return length ? `Incoming call, ${length}` : 'Incoming call'
  }
  if (status === 'no-answer' || status === 'busy') return 'Called them, no answer'
  if (status === 'failed' || status === 'canceled') return 'Call did not connect'
  return length ? `Called them, ${length}` : 'Called them'
}

// ---------------------------------------------------------------------------
// Collecting from the three sources
// ---------------------------------------------------------------------------

async function collectEntries(): Promise<{ entries: Entry[]; ours: Set<string> }> {
  if (!isTwilioConfigured()) return { entries: [], ours: new Set() }

  let numbers: SiteNumber[] = []
  try {
    numbers = await getSiteNumbers()
  } catch (err) {
    console.error('[twilio] could not read the site numbers:', err)
    return { entries: [], ours: new Set() }
  }

  if (numbers.length > MAX_NUMBERS) {
    console.warn(
      `[twilio] conversations cover the first ${MAX_NUMBERS} of ${numbers.length} site numbers; the rest are not listed`,
    )
  }
  const used = numbers.slice(0, MAX_NUMBERS)
  const ours = new Set(used.map((n) => normaliseNumber(n.phoneNumber)))

  const entries: Entry[] = []

  // One number failing costs that number, not the whole listing: a routing
  // region with nothing in it must not hide the number that does have the
  // messages on it.
  await Promise.all(
    used.map(async (number) => {
      try {
        const calls = await listCallsForNumber(number.phoneNumber, number.region, PER_NUMBER)
        for (const call of calls) {
          const inbound = call.direction === 'inbound'
          entries.push({
            id: `call:${call.sid}`,
            kind: 'call',
            party: normaliseNumber(inbound ? call.from : call.to),
            direction: inbound ? 'in' : 'out',
            at: new Date(call.startTime || 0),
            text: describeCall(inbound ? 'in' : 'out', call.status, call.durationSeconds),
          })
        }
      } catch (err) {
        console.error(`[twilio] could not read the calls for ${number.phoneNumber}:`, err)
      }

      if (!number.smsCapable) return
      try {
        const texts = await listMessagesForNumber(number.phoneNumber, number.region, PER_NUMBER)
        for (const text of texts) {
          const inbound = text.direction === 'inbound'
          entries.push({
            id: `sms:${text.sid}`,
            kind: 'sms',
            party: normaliseNumber(inbound ? text.from : text.to),
            direction: inbound ? 'in' : 'out',
            at: new Date(text.dateSent || 0),
            text: text.body ?? '',
          })
        }
      } catch (err) {
        console.error(`[twilio] could not read the texts for ${number.phoneNumber}:`, err)
      }
    }),
  )

  // Voicemail is the one part this module keeps, so it survives whatever
  // Twilio's own retention does to the recording listing.
  try {
    for (const voicemail of await recentVoicemails()) {
      const words = voicemail.transcriptionStatus === 'completed' && voicemail.transcriptionText
        ? voicemail.transcriptionText
        : `Voicemail, ${voicemail.durationSeconds} seconds`
      entries.push({
        id: `voicemail:${voicemail.recordingSid}`,
        kind: 'voicemail',
        party: normaliseNumber(voicemail.fromNumber),
        direction: 'in',
        at: voicemail.createdAt,
        text: words,
      })
    }
  } catch (err) {
    console.error('[twilio] could not read the voicemails:', err)
  }

  return { entries, ours }
}

// ---------------------------------------------------------------------------
// One conversation per outside number
// ---------------------------------------------------------------------------

type Grouped = {
  party: string
  entries: Entry[]
  lastAt: Date
  hasCall: boolean
}

function group(entries: Entry[], ours: Set<string>): Grouped[] {
  const byParty = new Map<string, Entry[]>()
  for (const entry of entries) {
    // A number of ours calling a number of ours is a forwarded call talking to
    // itself, not a conversation with anybody.
    if (ours.has(entry.party) || entry.party === 'unknown') continue
    const list = byParty.get(entry.party)
    if (list) list.push(entry)
    else byParty.set(entry.party, [entry])
  }

  const groups: Grouped[] = []
  for (const [party, list] of byParty) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime())
    const newest = list[list.length - 1]!
    groups.push({
      party,
      entries: list,
      lastAt: newest.at,
      hasCall: list.some((e) => e.kind !== 'sms'),
    })
  }
  return groups.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
}

function toSummary(g: Grouped): ConversationSummary {
  const newest = g.entries[g.entries.length - 1]!
  return {
    id: g.party,
    // Texts alone are a text conversation; anything with a call or a voicemail
    // in it is a phone one.
    channel: g.hasCall ? 'phone' : 'sms',
    subject: `Phone: ${g.party}`,
    preview: preview(newest.text),
    participant: { name: null, email: null, phone: g.party },
    lastMessageAt: g.lastAt,
    // Nothing here records who has looked at what, and inventing a read flag
    // this module does not keep would be a lie in both directions.
    unread: false,
    status: 'open',
    // Admin-root relative, no leading slash - the admin path is per site.
    href: 'm/twilio',
  }
}

function toMessages(g: Grouped): ConversationMessage[] {
  return g.entries.map((entry) => ({
    id: entry.id,
    direction: entry.direction,
    authorName: entry.direction === 'in' ? g.party : null,
    text: entry.text,
    html: null,
    sentAt: entry.at,
    attachments: [],
  }))
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

let slot: { promise: Promise<Grouped[]>; at: number } | null = null

/** Throw away what was collected, so the next read goes to Twilio.
 *
 *  Called after sending a text - somebody who has just sent one is exactly the
 *  person about to look for it - and by the tests, which would otherwise share
 *  one listing between them and prove nothing about the second. */
export function forgetCachedConversations(): void {
  slot = null
}

function loadGroups(): Promise<Grouped[]> {
  const now = Date.now()
  if (slot && now - slot.at < CACHE_TTL_MS) return slot.promise
  const promise = collectEntries().then(({ entries, ours }) => group(entries, ours))
  const mine = { promise, at: now }
  slot = mine
  // A failed round clears the slot rather than telling everybody for the next
  // five minutes that the phone has been silent.
  promise.catch(() => {
    if (slot === mine) slot = null
  })
  return promise
}

async function list(opts: ConversationListOptions): Promise<ConversationListPage> {
  const groups = await loadGroups()
  const since = opts.since?.getTime() ?? null
  const before = opts.cursor ? Date.parse(opts.cursor) : null

  const filtered = groups.filter((g) => {
    const at = g.lastAt.getTime()
    if (since !== null && at <= since) return false
    if (before !== null && !Number.isNaN(before) && at >= before) return false
    return true
  })

  const page = filtered.slice(0, opts.limit)
  const last = page[page.length - 1]
  return {
    items: page.map(toSummary),
    nextCursor: filtered.length > page.length && last ? last.lastAt.toISOString() : undefined,
  }
}

async function thread(id: string): Promise<ConversationThread | null> {
  const groups = await loadGroups()
  const found = groups.find((g) => g.party === normaliseNumber(id))
  if (!found) return null
  return { summary: toSummary(found), messages: toMessages(found) }
}

async function send(
  id: string,
  body: { text: string; html?: string; authorUserId: string },
): Promise<void> {
  const to = normaliseNumber(id)
  if (!/^\+\d{6,}$/.test(to)) {
    throw new Error('That number cannot be texted - it was withheld, or it is not a full number.')
  }
  await sendSiteSms(to, body.text)
  forgetCachedConversations()
}

async function byIdentity(identity: { phones: string[] }): Promise<ConversationSummary[]> {
  const wanted = new Set(identity.phones.map(normaliseNumber).filter((p) => p !== 'unknown'))
  if (wanted.size === 0) return []
  const groups = await loadGroups()
  return groups.filter((g) => wanted.has(g.party)).map(toSummary)
}

export const twilioConversationProvider: ConversationProvider = {
  label: 'Phone',
  channel: 'phone',
  capabilities: { reply: true, markRead: false, byIdentity: true },
  list,
  thread,
  send,
  byIdentity,
}
