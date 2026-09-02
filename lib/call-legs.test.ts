import { describe, expect, it } from 'vitest'
import { callOutcome, foldDialLegs, type RawCallLeg } from './call-legs'

// The pairs these fold are the two shapes the module actually produces. Both
// are easy to get subtly wrong in the same way: keep the wrong leg's number and
// the call log offers to block your own receptionist, and read the wrong leg's
// status and every missed call reads as a short conversation.

const SITE = '+441134960000'
const CALLER = '+447700900123'
const RECEPTION = '+447700900456'

function leg(over: Partial<RawCallLeg> & { sid: string }): RawCallLeg {
  return {
    from: CALLER,
    to: SITE,
    direction: 'inbound',
    status: 'completed',
    startTime: '2026-09-02T14:21:00Z',
    durationSeconds: 30,
    parentCallSid: '',
    ...over,
  }
}

const noRecordings = new Map<string, string[]>()

describe('foldDialLegs', () => {
  it('folds a forwarded call into the call that was forwarded', () => {
    const entries = foldDialLegs(
      [
        leg({ sid: 'CA1', durationSeconds: 27 }),
        leg({
          sid: 'CA2',
          from: SITE,
          to: RECEPTION,
          direction: 'outbound-dial',
          status: 'no-answer',
          durationSeconds: 0,
          parentCallSid: 'CA1',
        }),
      ],
      noRecordings,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sid: 'CA1',
      from: CALLER,
      to: SITE,
      direction: 'inbound',
      // The call itself completed; nobody picked the extension up.
      status: 'completed',
      connected: { kind: 'forwarded', number: RECEPTION, status: 'no-answer', durationSeconds: 0 },
    })
    expect(callOutcome(entries[0]!)).toEqual({ status: 'no-answer', durationSeconds: 0 })
  })

  it('names the person rung, not the person who placed the click-to-dial', () => {
    const entries = foldDialLegs(
      [
        leg({ sid: 'CA1', from: SITE, to: RECEPTION, direction: 'outbound-api', durationSeconds: 95 }),
        leg({
          sid: 'CA2',
          from: SITE,
          to: CALLER,
          direction: 'outbound-dial',
          status: 'completed',
          durationSeconds: 62,
          parentCallSid: 'CA1',
        }),
      ],
      noRecordings,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sid: 'CA1',
      to: CALLER,
      direction: 'outbound',
      connected: { kind: 'click-to-dial', number: RECEPTION, status: 'completed', durationSeconds: 62 },
    })
    // The length worth reporting is the talking, not the ninety-five seconds
    // that include listening to "press any key to connect".
    expect(callOutcome(entries[0]!)).toEqual({ status: 'completed', durationSeconds: 62 })
  })

  it('reports the leg that was answered when a number rings two phones in turn', () => {
    const entries = foldDialLegs(
      [
        leg({ sid: 'CA1' }),
        leg({
          sid: 'CA2',
          from: SITE,
          to: RECEPTION,
          direction: 'outbound-dial',
          status: 'no-answer',
          durationSeconds: 0,
          parentCallSid: 'CA1',
        }),
        leg({
          sid: 'CA3',
          from: SITE,
          to: '+447700900789',
          direction: 'outbound-dial',
          status: 'completed',
          durationSeconds: 44,
          startTime: '2026-09-02T14:21:25Z',
          parentCallSid: 'CA1',
        }),
      ],
      noRecordings,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]!.connected).toMatchObject({ number: '+447700900789', durationSeconds: 44 })
  })

  it('falls back to the last leg tried when none of them was answered', () => {
    const entries = foldDialLegs(
      [
        leg({ sid: 'CA1' }),
        leg({
          sid: 'CA2',
          to: RECEPTION,
          direction: 'outbound-dial',
          status: 'busy',
          durationSeconds: 0,
          parentCallSid: 'CA1',
        }),
        leg({
          sid: 'CA3',
          to: '+447700900789',
          direction: 'outbound-dial',
          status: 'no-answer',
          durationSeconds: 0,
          startTime: '2026-09-02T14:21:25Z',
          parentCallSid: 'CA1',
        }),
      ],
      noRecordings,
    )

    expect(entries[0]!.connected).toMatchObject({ number: '+447700900789', status: 'no-answer' })
  })

  it('gathers the recordings from both ends of a call onto the one row', () => {
    const entries = foldDialLegs(
      [
        leg({ sid: 'CA1' }),
        leg({ sid: 'CA2', to: RECEPTION, direction: 'outbound-dial', parentCallSid: 'CA1' }),
      ],
      new Map([
        ['CA1', ['RE1']],
        ['CA2', ['RE2']],
      ]),
    )

    expect(entries[0]!.recordingSids).toEqual(['RE1', 'RE2'])
  })

  it('keeps a dialled leg whose parent is off the end of the listing', () => {
    const entries = foldDialLegs(
      [leg({ sid: 'CA2', to: RECEPTION, direction: 'outbound-dial', parentCallSid: 'CA_MISSING' })],
      noRecordings,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ sid: 'CA2', direction: 'outbound', connected: null })
  })

  it('leaves an ordinary call alone', () => {
    const entries = foldDialLegs([leg({ sid: 'CA1' })], noRecordings)
    expect(entries).toEqual([
      {
        sid: 'CA1',
        from: CALLER,
        to: SITE,
        direction: 'inbound',
        status: 'completed',
        startTime: '2026-09-02T14:21:00Z',
        durationSeconds: 30,
        recordingSids: [],
        connected: null,
      },
    ])
  })
})

describe('callOutcome', () => {
  it('reads the call itself when there was no second leg', () => {
    expect(callOutcome({ status: 'no-answer', durationSeconds: 0, connected: null })).toEqual({
      status: 'no-answer',
      durationSeconds: 0,
    })
  })
})
