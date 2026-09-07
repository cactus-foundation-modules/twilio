import type {
  ConversationAttachment,
  ConversationListOptions,
  ConversationListPage,
  ConversationMessage,
  ConversationProvider,
  ConversationSummary,
  ConversationThread,
} from '@/lib/conversations/types'
import { getWhatsAppSender } from './whatsapp-config'
import { isTwilioConfigured, type TwilioRegion } from './twilio'
import {
  listWhatsAppMessagesAcross,
  sendWhatsAppText,
  windowProblem,
  type WhatsAppMessage,
} from './whatsapp'

// WhatsApp, published as conversations.
//
// Shaped like the phone provider next door and for the same reason: nothing is
// written down here. Twilio holds the messages, and a conversation is assembled
// on demand and grouped by the other person's number, so every WhatsApp message
// from one human is one conversation.
//
// A SEPARATE PROVIDER FROM THE PHONE ONE, deliberately. Calls, voicemail and
// texts are one thing to the person answering them - the telephone - and
// WhatsApp is not: it has its own rules about when you may write, its own
// approved wording, and people expect to see it as its own channel rather than
// mixed in with the answerphone. Two providers means two channels wherever they
// are consumed, which is the honest arrangement.
//
// SERVER ONLY. The manifest entry sets serverOnly: this file reaches the
// account credentials by way of lib/whatsapp.ts and must never reach a browser
// bundle.

/** How many messages are read per pass. One request each way, capped. */
const PER_PASS = 100

/** How long an assembled listing is reused. Same reasoning as the phone
 *  provider: a screen drawn twice costs one round of requests, and a message
 *  arriving is not invisible for the afternoon. */
const CACHE_TTL_MS = 5 * 60_000

const PREVIEW_CHARS = 160

function preview(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat
}

/** A number in the form everything else compares on. WhatsApp always has a real
 *  number behind it - there is no withheld caller here - so anything that is
 *  not one is a value we should not be grouping on. */
function normaliseNumber(value: string): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return 'unknown'
  if (/^\+/.test(trimmed)) return trimmed.replace(/[^\d+]/g, '')
  return trimmed.toLowerCase()
}

/** What a message with no words says it is. A photograph with no caption is
 *  still something somebody sent, and an empty row in a list is not. */
function describe(message: WhatsAppMessage): string {
  if (message.body.trim()) return message.body
  if (message.media.length === 0) return ''
  const images = message.media.filter((m) => m.contentType.startsWith('image/')).length
  if (images === message.media.length) {
    return images === 1 ? 'Sent a photo' : `Sent ${images} photos`
  }
  return message.media.length === 1 ? 'Sent a file' : `Sent ${message.media.length} files`
}

type Grouped = {
  party: string
  messages: WhatsAppMessage[]
  lastAt: Date
  /** When they last wrote to US. Decides whether a plain reply will be
   *  delivered at all, so it is carried rather than recomputed. */
  lastInboundAt: Date | null
  /** The region this conversation was actually found in - where a reply has to
   *  be posted and where its media lives. Not necessarily the region the site
   *  has written down; see listWhatsAppMessagesAcross. */
  region: TwilioRegion
}

function group(messages: WhatsAppMessage[], ours: string): Grouped[] {
  const mine = normaliseNumber(ours)
  const byParty = new Map<string, WhatsAppMessage[]>()
  for (const message of messages) {
    const party = normaliseNumber(message.direction === 'inbound' ? message.from : message.to)
    if (party === mine || party === 'unknown') continue
    const list = byParty.get(party)
    if (list) list.push(message)
    else byParty.set(party, [message])
  }

  const groups: Grouped[] = []
  for (const [party, list] of byParty) {
    list.sort((a, b) => Date.parse(a.dateSent || '0') - Date.parse(b.dateSent || '0'))
    const newest = list[list.length - 1]!
    const lastInbound = [...list].reverse().find((m) => m.direction === 'inbound')
    groups.push({
      party,
      messages: list,
      lastAt: new Date(newest.dateSent || 0),
      lastInboundAt: lastInbound ? new Date(lastInbound.dateSent || 0) : null,
      region: newest.region,
    })
  }
  return groups.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
}

function toSummary(g: Grouped): ConversationSummary {
  const newest = g.messages[g.messages.length - 1]!
  return {
    id: g.party,
    channel: 'whatsapp',
    subject: `WhatsApp: ${g.party}`,
    preview: preview(describe(newest)),
    participant: { name: null, email: null, phone: g.party },
    lastMessageAt: g.lastAt,
    // Nothing here records who has looked at what, and inventing a read flag
    // this module does not keep would be a lie in both directions.
    unread: false,
    status: 'open',
    // Admin-root relative, no leading slash - the admin path is per site. The
    // settings screen is `config`; the two query keys are the settings tab and
    // the Twilio tab's own sub-tab.
    href: 'config?tab=twilio&sub=whatsapp',
  }
}

function toMessages(g: Grouped): ConversationMessage[] {
  return g.messages.map((message) => {
    const attachments: ConversationAttachment[] = message.media.map((media, index) => ({
      // Twilio does not give a media file a name, so one is made from what it
      // is and where it sat. A person downloading three photographs needs them
      // to be three different files more than they need them to be well named.
      filename: `whatsapp-${message.sid}-${index + 1}${extensionFor(media.contentType)}`,
      url: `/api/m/twilio/admin/whatsapp/media/${encodeURIComponent(message.sid)}/${encodeURIComponent(media.sid)}?region=${encodeURIComponent(message.region)}`,
      contentType: media.contentType,
    }))
    return {
      id: `whatsapp:${message.sid}`,
      direction: message.direction === 'inbound' ? 'in' : 'out',
      authorName: message.direction === 'inbound' ? g.party : null,
      text: describe(message),
      html: null,
      sentAt: new Date(message.dateSent || 0),
      attachments,
    }
  })
}

/** A file extension for a content type, so a downloaded photograph opens in the
 *  thing that opens photographs. Unknown types get none rather than a guess. */
function extensionFor(contentType: string): string {
  const known: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'application/pdf': '.pdf',
  }
  return known[contentType.split(';')[0]!.trim().toLowerCase()] ?? ''
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

let slot: { promise: Promise<Grouped[]>; at: number } | null = null

/** Throw away what was collected, so the next read goes to Twilio. Called after
 *  sending - somebody who has just written one is exactly the person about to
 *  look for it - and by the tests, which would otherwise share one listing. */
export function forgetCachedWhatsApp(): void {
  slot = null
}

async function collect(): Promise<Grouped[]> {
  if (!isTwilioConfigured()) return []
  const sender = await getWhatsAppSender()
  if (!sender) return []
  try {
    const messages = await listWhatsAppMessagesAcross(sender.phoneNumber, sender.regions, PER_PASS)
    return group(messages, sender.phoneNumber)
  } catch (err) {
    console.error('[twilio] could not read the WhatsApp messages:', err)
    throw err
  }
}

function loadGroups(): Promise<Grouped[]> {
  const now = Date.now()
  if (slot && now - slot.at < CACHE_TTL_MS) return slot.promise
  const promise = collect()
  const mine = { promise, at: now }
  slot = mine
  // A failed round clears the slot rather than telling everybody for the next
  // five minutes that nobody has been in touch.
  promise.catch(() => {
    if (slot === mine) slot = null
  })
  return promise
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

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

/**
 * Reply, when WhatsApp will carry a reply.
 *
 * The window is checked BEFORE the send rather than after: Twilio accepts an
 * out-of-window free-text message and Meta drops it, so a caller that did not
 * check would be told the message went and the customer would never see it,
 * which is the one outcome worse than a refusal. The refusal says what to do
 * instead, because there is something to do - send an approved template from
 * the WhatsApp screen.
 */
async function send(id: string, body: { text: string; authorUserId: string }): Promise<void> {
  const to = normaliseNumber(id)
  if (!/^\+\d{6,}$/.test(to)) {
    throw new Error('That is not a number WhatsApp can be sent to.')
  }
  const sender = await getWhatsAppSender()
  if (!sender) {
    throw new Error('WhatsApp is not set up on this site yet - turn it on and choose a sending number on the Twilio settings tab.')
  }

  const groups = await loadGroups()
  const found = groups.find((g) => g.party === to)
  const problem = windowProblem(found?.lastInboundAt ?? null)
  if (problem) throw new Error(problem)

  // Posted to the region the conversation was actually found in - the site's
  // own setting is only right by luck when Twilio filed the sender elsewhere.
  await sendWhatsAppText(to, body.text, sender.phoneNumber, found?.region ?? sender.region)
  forgetCachedWhatsApp()
}

async function byIdentity(identity: { phones: string[] }): Promise<ConversationSummary[]> {
  const wanted = new Set(identity.phones.map(normaliseNumber).filter((p) => p !== 'unknown'))
  if (wanted.size === 0) return []
  const groups = await loadGroups()
  return groups.filter((g) => wanted.has(g.party)).map(toSummary)
}

export const whatsappConversationProvider: ConversationProvider = {
  label: 'WhatsApp',
  channel: 'whatsapp',
  // Nothing is deleted and nobody is blocked: Twilio holds the messages under
  // its own retention, and an inbound WhatsApp message never passes through a
  // webhook of ours where it could be refused. Claiming either would put a
  // button on a screen that cannot do what it says.
  capabilities: { reply: true, markRead: false, byIdentity: true, delete: false, block: false },
  list,
  thread,
  send,
  byIdentity,
}
