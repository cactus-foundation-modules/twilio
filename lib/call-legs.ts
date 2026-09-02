// Two Twilio call records, one telephone conversation.
//
// A <Dial> in TwiML does not extend the call it sits in: it starts a second
// call - a child - which Twilio stamps with its parent's SID and the direction
// 'outbound-dial'. Both legs are ordinary rows in the Calls listing, and this
// module produces a pair every time it does anything interesting:
//
//   Forwarded call   parent: the caller      -> a site number     (inbound)
//                    child:  the site number -> whoever the number forwards to
//
//   Click-to-dial    parent: the site number -> whoever placed the call
//                    child:  the site number -> the person being rung
//
// Left as they come, that is two rows in the call log for one call, and - far
// worse in a merged inbox - two conversations: one with the customer and one
// with your own receptionist's mobile. So the child is folded into its parent
// here, and the two things only the child knows are carried on the parent as
// `connected`: who was really on the far end, and whether they picked up.
//
// That second one matters more than it looks. An inbound call that rang out to
// voicemail is 'completed' on the parent - it did reach Twilio, played a
// greeting and rang for twenty seconds - and only the child leg says nobody
// answered. Read the parent alone and every missed call reads as a short chat.

export type RawCallLeg = {
  sid: string
  from: string
  to: string
  /** Twilio's own value: 'inbound', 'outbound-api' or 'outbound-dial'. */
  direction: string
  status: string
  startTime: string
  durationSeconds: number
  /** The SID of the call this one was dialled from, empty when there is none. */
  parentCallSid: string
}

/** The second leg of a call, once it has been folded into the first. */
export type ConnectedLeg = {
  /** 'forwarded' - an inbound call passed on to another number.
   *  'click-to-dial' - an outbound call that rang the person placing it first. */
  kind: 'forwarded' | 'click-to-dial'
  /** The site's own end of that leg: the number the call was forwarded to, or
   *  the number the caller asked to be rung on. */
  number: string
  status: string
  durationSeconds: number
}

export type CallLogEntry = {
  sid: string
  from: string
  to: string
  direction: 'inbound' | 'outbound'
  status: string
  startTime: string
  durationSeconds: number
  recordingSids: string[]
  /** Null unless the call was joined to a second leg by <Dial>. */
  connected: ConnectedLeg | null
}

/** Which of several legs to report on. A number can ring two phones in turn
 *  (the second forwarding number), so the one that matters is the one somebody
 *  picked up, and failing that the last one tried. */
function pickLeg(children: RawCallLeg[]): RawCallLeg | null {
  if (children.length === 0) return null
  const answered = children.find((c) => c.status === 'completed' && c.durationSeconds > 0)
  if (answered) return answered
  return [...children].sort((a, b) => Date.parse(a.startTime || '0') - Date.parse(b.startTime || '0')).at(-1) ?? null
}

/** Folds each dialled leg into the call it was dialled from. Legs arrive in no
 *  particular order; the result is in the same order as the parents came in.
 *
 *  A child whose parent is not in this page of the listing stays a row of its
 *  own. There is nothing here to fold it into, and dropping it would lose the
 *  call altogether. */
export function foldDialLegs(legs: RawCallLeg[], recordingsByCall: Map<string, string[]>): CallLogEntry[] {
  const bySid = new Map(legs.map((leg) => [leg.sid, leg]))
  const isFoldable = (leg: RawCallLeg) => Boolean(leg.parentCallSid) && bySid.has(leg.parentCallSid)

  const childrenByParent = new Map<string, RawCallLeg[]>()
  for (const leg of legs) {
    if (!isFoldable(leg)) continue
    const list = childrenByParent.get(leg.parentCallSid) ?? []
    list.push(leg)
    childrenByParent.set(leg.parentCallSid, list)
  }

  const entries: CallLogEntry[] = []
  for (const leg of legs) {
    if (isFoldable(leg)) continue
    const children = childrenByParent.get(leg.sid) ?? []
    const chosen = pickLeg(children)
    const inbound = !leg.direction.startsWith('outbound')

    // A recording of a forwarded call is attached to whichever leg Twilio was
    // recording, so both ends contribute and the set keeps the order without
    // listing the same recording twice.
    const recordingSids = [
      ...new Set([
        ...(recordingsByCall.get(leg.sid) ?? []),
        ...children.flatMap((child) => recordingsByCall.get(child.sid) ?? []),
      ]),
    ]

    entries.push({
      sid: leg.sid,
      from: leg.from,
      // Click-to-dial rings whoever placed the call first, so the parent's To
      // is one of ours. The person the site actually rang is on the child leg,
      // and they are who this row is about.
      to: chosen && !inbound ? chosen.to : leg.to,
      direction: inbound ? 'inbound' : 'outbound',
      status: leg.status,
      durationSeconds: leg.durationSeconds,
      startTime: leg.startTime,
      recordingSids,
      connected: chosen
        ? {
            kind: inbound ? 'forwarded' : 'click-to-dial',
            number: inbound ? chosen.to : leg.to,
            status: chosen.status,
            durationSeconds: chosen.durationSeconds,
          }
        : null,
    })
  }
  return entries
}

/** What happened between the two humans, which is not always what happened to
 *  the call. Where there is a second leg its status and its length are the
 *  answer: the parent of a forwarded call is 'completed' whether or not anybody
 *  picked the phone up, and its length counts the greeting and the ringing. */
export function callOutcome(call: {
  status: string
  durationSeconds: number
  connected?: ConnectedLeg | null
}): { status: string; durationSeconds: number } {
  const connected = call.connected
  if (!connected) return { status: call.status, durationSeconds: call.durationSeconds }
  return { status: connected.status, durationSeconds: connected.durationSeconds }
}
