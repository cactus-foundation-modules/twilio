// WhatsApp over Twilio.
//
// Twilio carries WhatsApp on the SAME Messages resource as SMS. The only
// difference on the wire is the addressing: both ends are written
// "whatsapp:+447700900123" rather than "+447700900123". So there is no second
// API to learn and no message store to keep - a WhatsApp conversation is read
// live from Twilio exactly as the call and text logs already are.
//
// Three things about WhatsApp are NOT like texting, and all three are the
// reason this file exists rather than a couple of extra arguments on sendSms:
//
//   THE 24-HOUR WINDOW. WhatsApp will only carry free text for 24 hours after
//   the customer's last message. Outside that, Meta refuses it and only an
//   approved template will go. This is not a Twilio rule and cannot be turned
//   off, so it is checked here and said in English rather than left to come
//   back as a Twilio error code nobody can act on.
//
//   TEMPLATES ARE NOT TEXT. An out-of-window message is sent by Content SID
//   with its variables as JSON, not as a body. Different form fields, different
//   Twilio parameters, different failure modes.
//
//   MEDIA IS ORDINARY. People send photographs on WhatsApp the way they send
//   words, so dropping them would lose half of what was said. Twilio does not
//   put media on the message listing - it takes one further request per message
//   that has any - so they are fetched for a bounded number of messages and the
//   content is streamed through this site rather than linked, because Twilio's
//   media URLs are behind the account credentials.
//
//   REGIONS ARE NOT THE NUMBER'S. A phone number's calls and texts are processed
//   in the region it is ROUTED to, and that routing does not move WhatsApp: a
//   WhatsApp sender belongs to the account, and its messages are filed in the
//   region Twilio registered the sender in - usually the account's home region,
//   whatever the same number's telephony does. Asking the wrong region returns
//   an empty list rather than an error, which reads on screen as "nobody has
//   ever written to you", so every read here sweeps EVERY region the site holds
//   a token for and each message carries the region it was found in.
//
// SERVER ONLY: carries the account credentials by way of lib/twilio.ts.
import {
  authHeader,
  getHomeRegion,
  regionCredentials,
  regionHost,
  twilioFetch,
  type TwilioRegion,
} from './twilio'

/** How Twilio addresses a WhatsApp end of a conversation. */
const WHATSAPP_PREFIX = 'whatsapp:'

/** Meta's free-text window: 24 hours from the customer's last inbound message.
 *  Outside it, only an approved template will be delivered. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60_000

/** How many of a listing's messages are opened to fetch their media. Each one
 *  is a further Twilio request, and this listing is drawn from a merged inbox
 *  that may be read often, so it is capped like everything else here. Messages
 *  beyond the cap keep their words and lose their pictures for that pass. */
const MAX_MEDIA_LOOKUPS = 20

/** Twilio's own id shapes, so a pasted value is refused here rather than 400ing
 *  at Twilio with a message about a resource. */
const CONTENT_SID_RE = /^HX[0-9a-fA-F]{32}$/
const MESSAGE_SID_RE = /^[A-Z]{2}[0-9a-fA-F]{32}$/
const MEDIA_SID_RE = /^ME[0-9a-fA-F]{32}$/

export function isContentSid(value: string): boolean {
  return CONTENT_SID_RE.test(value)
}

export function isMessageSid(value: string): boolean {
  return MESSAGE_SID_RE.test(value)
}

export function isMediaSid(value: string): boolean {
  return MEDIA_SID_RE.test(value)
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/** E.164 in, Twilio's WhatsApp address out. Already-prefixed values pass
 *  through, so a value that has been round-tripped is not double-prefixed. */
export function toWhatsAppAddress(phoneNumber: string): string {
  const trimmed = phoneNumber.trim()
  return trimmed.startsWith(WHATSAPP_PREFIX) ? trimmed : `${WHATSAPP_PREFIX}${trimmed}`
}

/** Twilio's WhatsApp address in, plain E.164 out. Anything without the prefix
 *  is handed back untouched: it is either already plain or it is not a number
 *  at all, and inventing a shape for it would hide that. */
export function fromWhatsAppAddress(address: string): string {
  const trimmed = (address ?? '').trim()
  return trimmed.startsWith(WHATSAPP_PREFIX) ? trimmed.slice(WHATSAPP_PREFIX.length) : trimmed
}

export function isWhatsAppAddress(address: string): boolean {
  return (address ?? '').trim().startsWith(WHATSAPP_PREFIX)
}

// ---------------------------------------------------------------------------
// The 24-hour window
// ---------------------------------------------------------------------------

/** Whether free text will still be delivered to somebody. Null = they have
 *  never written, which is outside the window rather than inside it: a
 *  conversation nobody started can only be opened with a template. */
export function isWindowOpen(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false
  const at = lastInboundAt.getTime()
  if (Number.isNaN(at)) return false
  return now.getTime() - at < WHATSAPP_WINDOW_MS
}

/** Why a free-text message will not go, in the words somebody can act on.
 *  Null when it will. */
export function windowProblem(lastInboundAt: Date | null, now: Date = new Date()): string | null {
  if (isWindowOpen(lastInboundAt, now)) return null
  if (!lastInboundAt) {
    return 'WhatsApp will not carry an ordinary message to somebody who has never written to you - only an approved template can start a conversation.'
  }
  return 'It is more than 24 hours since they last wrote, so WhatsApp will only carry an approved template until they write again.'
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** A free-text WhatsApp message. Only delivered inside the 24-hour window -
 *  callers check `windowProblem` first, because Twilio accepts this and Meta
 *  drops it, which is the worst of both. */
export async function sendWhatsAppText(
  to: string,
  body: string,
  from: string,
  region: TwilioRegion = getHomeRegion(),
): Promise<string> {
  const data = (await twilioFetch('/Messages.json', {
    method: 'POST',
    form: {
      To: toWhatsAppAddress(to),
      From: toWhatsAppAddress(from),
      Body: body,
    },
    region,
  })) as { sid?: string }
  return data.sid ?? ''
}

/**
 * An approved template, by Content SID.
 *
 * Twilio takes the variables as a JSON object keyed "1", "2", … in the order
 * the template declares them, which is why the caller passes an array and the
 * numbering is done here: a caller counting from zero would silently fill the
 * wrong blanks in a message going to a customer.
 */
export async function sendWhatsAppTemplate(
  to: string,
  contentSid: string,
  variables: string[],
  from: string,
  region: TwilioRegion = getHomeRegion(),
): Promise<string> {
  if (!isContentSid(contentSid)) {
    throw new Error('That is not a Twilio template id - it should start with HX followed by 32 characters.')
  }
  const form: Record<string, string> = {
    To: toWhatsAppAddress(to),
    From: toWhatsAppAddress(from),
    ContentSid: contentSid,
  }
  if (variables.length > 0) {
    form.ContentVariables = JSON.stringify(
      Object.fromEntries(variables.map((value, index) => [String(index + 1), value])),
    )
  }
  const data = (await twilioFetch('/Messages.json', { method: 'POST', form, region })) as { sid?: string }
  return data.sid ?? ''
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type WhatsAppMedia = {
  /** Twilio's media SID, for the proxy route that streams the content. */
  sid: string
  contentType: string
}

export type WhatsAppMessage = {
  sid: string
  /** Plain E.164, prefix already stripped - nothing above this file should have
   *  to know how Twilio writes a WhatsApp address. */
  from: string
  to: string
  direction: 'inbound' | 'outbound'
  status: string
  dateSent: string
  body: string
  media: WhatsAppMedia[]
  /** Which region this message was found in. Carried rather than assumed: its
   *  media can only be fetched from here, and a reply can only be sent from
   *  here, and neither is necessarily the region the site has written down. */
  region: TwilioRegion
}

type RawMessage = {
  sid: string
  from: string
  to: string
  direction: string
  status: string
  date_sent: string | null
  date_created: string | null
  body: string | null
  num_media: string | null
}

/** The media on one message. One request, so callers batch and cap. */
export async function listMessageMedia(
  messageSid: string,
  region: TwilioRegion = getHomeRegion(),
): Promise<WhatsAppMedia[]> {
  const data = (await twilioFetch(
    `/Messages/${encodeURIComponent(messageSid)}/Media.json?PageSize=10`,
    { region },
  )) as { media_list?: Array<{ sid: string; content_type: string | null }> }
  return (data.media_list ?? []).map((m) => ({ sid: m.sid, contentType: m.content_type ?? 'application/octet-stream' }))
}

/**
 * WhatsApp messages to and from one sender, newest first.
 *
 * Same merge-two-listings shape as listMessagesForNumber, and the same Region
 * rule: a message was processed in the Region its sender is routed to and
 * exists nowhere else.
 *
 * Filtering is by ADDRESS rather than by scanning everything and picking the
 * WhatsApp ones out: a busy site's texts would otherwise fill the page before a
 * single WhatsApp message appeared.
 */
export async function listWhatsAppMessages(
  sender: string,
  region: TwilioRegion = getHomeRegion(),
  limit = 50,
): Promise<WhatsAppMessage[]> {
  const address = toWhatsAppAddress(sender)
  const [toData, fromData] = (await Promise.all([
    twilioFetch(`/Messages.json?PageSize=${limit}&To=${encodeURIComponent(address)}`, { region }),
    twilioFetch(`/Messages.json?PageSize=${limit}&From=${encodeURIComponent(address)}`, { region }),
  ])) as [{ messages?: RawMessage[] }, { messages?: RawMessage[] }]

  const bySid = new Map<string, RawMessage>()
  for (const m of [...(toData.messages ?? []), ...(fromData.messages ?? [])]) bySid.set(m.sid, m)

  // num_media rides along while the media is being fetched and is dropped on the
  // way out: it is Twilio's bookkeeping, not something a conversation has.
  type Pending = WhatsAppMessage & { numMedia: number }

  const messages: Pending[] = [...bySid.values()]
    .map((m) => ({
      sid: m.sid,
      from: fromWhatsAppAddress(m.from),
      to: fromWhatsAppAddress(m.to),
      direction: m.direction === 'inbound' ? ('inbound' as const) : ('outbound' as const),
      status: m.status,
      dateSent: m.date_sent ?? m.date_created ?? '',
      body: m.body ?? '',
      media: [] as WhatsAppMedia[],
      region,
      numMedia: m.num_media ? parseInt(m.num_media, 10) || 0 : 0,
    }))
    .sort((a, b) => Date.parse(b.dateSent || '0') - Date.parse(a.dateSent || '0'))
    .slice(0, limit)

  // Newest first, so the cap spends its requests on what somebody is actually
  // looking at rather than on last month's photographs.
  const withMedia = messages.filter((m) => m.numMedia > 0).slice(0, MAX_MEDIA_LOOKUPS)
  await Promise.all(
    withMedia.map(async (message) => {
      try {
        message.media = await listMessageMedia(message.sid, region)
      } catch (err) {
        // One message's attachments failing costs that message's attachments.
        // The words are the part that must not be lost to a bad minute.
        console.error(`[twilio] could not read the media on WhatsApp message ${message.sid}:`, err)
      }
    }),
  )

  return messages.map(({ numMedia: _numMedia, ...message }) => message)
}

/**
 * The same listing, swept across every region the site holds a token for.
 *
 * This is what callers should use. A WhatsApp sender is registered against the
 * ACCOUNT, in whichever region Twilio put it, and that has nothing to do with
 * the inbound processing region of the identically-numbered phone line: a
 * number whose calls are handled in Ireland can perfectly well have its
 * WhatsApp filed in the United States. Twilio does not complain about the
 * mismatch - the wrong region simply answers with an empty list, which reads on
 * screen as a customer who has never been in touch and quietly blocks every
 * reply to them.
 *
 * A region that fails is logged and skipped, because one region being unwell
 * should not hide the conversations held in the other. All of them failing
 * throws, because an empty list would be a lie.
 */
export async function listWhatsAppMessagesAcross(
  sender: string,
  regions: readonly TwilioRegion[],
  limit = 50,
): Promise<WhatsAppMessage[]> {
  const wanted = regions.length > 0 ? [...regions] : [getHomeRegion()]
  const settled = await Promise.allSettled(
    wanted.map((region) => listWhatsAppMessages(sender, region, limit)),
  )

  const found: WhatsAppMessage[] = []
  const failures: unknown[] = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      found.push(...result.value)
      return
    }
    failures.push(result.reason)
    console.error(`[twilio] could not read the WhatsApp messages in ${wanted[index]}:`, result.reason)
  })

  if (failures.length === wanted.length) {
    throw failures[0] instanceof Error
      ? failures[0]
      : new Error('The WhatsApp messages could not be read')
  }

  // One message cannot be in two regions, so a duplicate SID would be Twilio
  // answering twice; keeping the first is as good as keeping either.
  const bySid = new Map<string, WhatsAppMessage>()
  for (const message of found) if (!bySid.has(message.sid)) bySid.set(message.sid, message)

  return [...bySid.values()]
    .sort((a, b) => Date.parse(b.dateSent || '0') - Date.parse(a.dateSent || '0'))
    .slice(0, limit)
}

/**
 * Which region to send from, worked out from what has already been said.
 *
 * The newest message involving that person is the only reliable evidence of
 * where this sender's WhatsApp lives, because it is where Twilio actually filed
 * one. With nothing to go on - a person who has never been in touch, on a site
 * that has never sent anything - the site's own setting is used, which is the
 * best guess available and the one an owner can correct.
 */
export function regionForParty(
  messages: readonly WhatsAppMessage[],
  party: string,
  fallback: TwilioRegion,
): TwilioRegion {
  const wanted = party.trim()
  const theirs = messages.find((m) => m.from === wanted || m.to === wanted)
  return theirs?.region ?? messages[0]?.region ?? fallback
}

/**
 * Streams one media file with the Region's basic-auth credentials, so the
 * browser never sees them.
 *
 * Twilio's media URLs are behind the account credentials, which is why this is
 * a proxy rather than a link: putting a signed-looking Twilio URL in the page
 * would either not load or would hand the account's media host to whoever the
 * page reached.
 */
export async function fetchMessageMedia(
  messageSid: string,
  mediaSid: string,
  region: TwilioRegion = getHomeRegion(),
): Promise<Response> {
  const { accountSid, authToken } = regionCredentials(region)
  return fetch(
    `https://${regionHost('api', region)}/2010-04-01/Accounts/${accountSid}/Messages/${encodeURIComponent(messageSid)}/Media/${encodeURIComponent(mediaSid)}`,
    {
      headers: { Authorization: authHeader(accountSid, authToken) },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    },
  )
}
