'use client'

// Main Twilio admin page: one tab per phone number on the account, each with
// a click-to-dial card, the number's call log (with recording playback) and
// its text message log. Forwarding configuration lives on the core settings
// page (Twilio tab).
import { useCallback, useEffect, useState } from 'react'
import { TabStrip } from '@/components/admin/TabStrip'
import { setTabParam } from '@/modules/twilio/lib/admin-tab-url'

type NumberRow = {
  sid: string
  phoneNumber: string
  friendlyName: string
}

type CallLogEntry = {
  sid: string
  from: string
  to: string
  direction: 'inbound' | 'outbound'
  status: string
  startTime: string
  durationSeconds: number
  recordingSids: string[]
  /** The recordingSids that are voicemail messages rather than recorded calls. */
  voicemailSids: string[]
  /** Twilio's typed-up voicemail text, per recording SID, where one was asked for. */
  transcriptions: Record<string, { status: string; text: string }>
}

type BlockedRow = {
  phoneNumber: string
  reason: string
  blockedByName: string | null
  createdAt: string
}

type MessageLogEntry = {
  sid: string
  from: string
  to: string
  direction: 'inbound' | 'outbound'
  status: string
  dateSent: string
  body: string
}

const CALL_ME_AT_KEY = 'twilio-call-me-at'

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '1px solid var(--color-border)',
  whiteSpace: 'nowrap',
}

const tdStyle: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text)',
  borderBottom: '1px solid var(--color-border)',
  verticalAlign: 'top',
}

function DirectionBadge({ direction }: { direction: 'inbound' | 'outbound' }) {
  return (
    <span
      style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--color-text-secondary)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        padding: '0 var(--space-2)',
        whiteSpace: 'nowrap',
      }}
    >
      {direction === 'inbound' ? 'Incoming' : 'Outgoing'}
    </span>
  )
}

// Marks a recording as a message somebody left rather than a recording of a
// call that was answered. Only shown on recordings known to be voicemail: an
// unmarked recording is the ordinary kind, not an unknown one.
function VoicemailBadge() {
  return (
    <span
      style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--color-primary)',
        border: '1px solid var(--color-primary)',
        borderRadius: 'var(--radius-sm)',
        padding: '0 var(--space-2)',
        whiteSpace: 'nowrap',
      }}
    >
      Voicemail
    </span>
  )
}

function MakeCallCard({ fromNumber }: { fromNumber: string }) {
  const [to, setTo] = useState('')
  const [callMeAt, setCallMeAt] = useState('')
  const [placing, setPlacing] = useState(false)
  const [placed, setPlaced] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- must read after mount, not in the initializer, or the client's first render diverges from server HTML
      setCallMeAt(localStorage.getItem(CALL_ME_AT_KEY) ?? '')
    } catch {
      // Storage unavailable - the field just starts empty.
    }
  }, [])

  async function makeCall() {
    setPlacing(true)
    setPlaced(false)
    setError('')
    try {
      const res = await fetch('/api/m/twilio/admin/make-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromNumber, to, callMeAt }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to place call')
      setPlaced(true)
      try {
        localStorage.setItem(CALL_ME_AT_KEY, callMeAt)
      } catch {
        // Storage unavailable - remembering the number is a nicety only.
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to place call')
    } finally {
      setPlacing(false)
    }
  }

  return (
    <div className="card">
      <h2 className="card-title">Make a call</h2>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
        We ring your phone first, then connect you when you press a key. The person you are
        calling sees {fromNumber} as the caller ID.
      </p>

      {error && <div className="alert alert-danger">{error}</div>}
      {placed && (
        <div className="alert alert-success">
          Calling you now at {callMeAt}. Answer and press any key to be connected.
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-4)' }}>
        <div className="field" style={{ margin: 0, flex: '1 1 14rem' }}>
          <label>Number to call</label>
          <input
            type="tel"
            value={to}
            placeholder="+447700900123"
            onChange={(e) => { setTo(e.target.value); setPlaced(false) }}
          />
        </div>
        <div className="field" style={{ margin: 0, flex: '1 1 14rem' }}>
          <label>Your phone (we call you first)</label>
          <input
            type="tel"
            value={callMeAt}
            placeholder="+447700900123"
            onChange={(e) => { setCallMeAt(e.target.value); setPlaced(false) }}
          />
        </div>
        <button
          className="btn btn-primary"
          disabled={placing || !to.trim() || !callMeAt.trim()}
          onClick={makeCall}
        >
          {placing ? 'Placing call…' : 'Make call'}
        </button>
      </div>
    </div>
  )
}

// A caller who has been blocked. Small, quiet, and beside the number rather
// than anywhere near the delete controls: blocking and erasing are different
// decisions and the screen should not blur them.
function BlockedBadge() {
  return (
    <span
      style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--color-destructive-hover)',
        border: '1px solid var(--color-destructive-hover)',
        borderRadius: 'var(--radius-sm)',
        padding: '0 var(--space-2)',
        whiteSpace: 'nowrap',
      }}
    >
      Blocked
    </span>
  )
}

// Block or unblock the person on the other end of one call, from the row that
// call is on - which is where somebody actually decides they have had enough.
//
// A withheld caller gets an em dash and no button. There is no number to keep,
// so a block here would either do nothing or block every withheld caller at
// once while claiming to block one; the number's own withheld-caller setting is
// the honest way to turn those away, and the title says so.
function CallerCell({ party, blocked, onChanged }: {
  party: string
  blocked: boolean
  onChanged: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!/^\+/.test(party)) {
    return (
      <span
        style={{ color: 'var(--color-text-secondary)' }}
        title="This caller withheld their number, so there is nothing to block. Use the number's setting for withheld callers instead."
      >
        &mdash;
      </span>
    )
  }

  async function toggle() {
    setBusy(true)
    setError('')
    try {
      const response = blocked
        ? await fetch(`/api/m/twilio/admin/blocked-numbers?number=${encodeURIComponent(party)}`, { method: 'DELETE' })
        : await fetch('/api/m/twilio/admin/blocked-numbers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber: party }),
          })
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That did not work.')
        return
      }
      await onChanged()
    } catch {
      setError('The site could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', alignItems: 'flex-start' }}>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void toggle()}>
        {busy ? (blocked ? 'Unblocking…' : 'Blocking…') : blocked ? 'Unblock' : 'Block'}
      </button>
      {blocked && <BlockedBadge />}
      {error && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-destructive-hover)' }} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

// Everybody currently turned away, and a box to add one by hand.
//
// The by-hand box exists because the worst callers are often the ones who have
// not rung yet: somebody who has had the number passed to them, or a number
// read off a colleague's phone. Waiting for a nuisance call to arrive before
// being allowed to stop it is the wrong way round.
function BlockedCallersCard({ blocked, error, onChanged }: {
  blocked: BlockedRow[] | null
  error: string
  onChanged: () => Promise<void> | void
}) {
  const [adding, setAdding] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [addError, setAddError] = useState('')

  async function add() {
    setBusy(true)
    setAddError('')
    try {
      const response = await fetch('/api/m/twilio/admin/blocked-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: adding, reason }),
      })
      if (!response.ok) {
        setAddError((await response.json().catch(() => null))?.error ?? 'That did not work.')
        return
      }
      setAdding('')
      setReason('')
      await onChanged()
    } catch {
      setAddError('The site could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(phoneNumber: string) {
    const response = await fetch(
      `/api/m/twilio/admin/blocked-numbers?number=${encodeURIComponent(phoneNumber)}`,
      { method: 'DELETE' },
    )
    if (response.ok) await onChanged()
  }

  return (
    <div className="card">
      <h2 className="card-title">Blocked callers</h2>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
        Calls from these numbers are refused before anything rings, records or sends. Nothing
        already in the log is removed - blocking somebody and clearing their history are
        separate decisions.
      </p>

      {error && <div className="alert alert-danger">{error}</div>}

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <input
          className="input"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="+44 7700 900123"
          aria-label="Number to block"
          style={{ maxWidth: '14rem' }}
        />
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why (optional)"
          aria-label="Why this number is blocked"
          style={{ maxWidth: '18rem' }}
        />
        <button className="btn btn-secondary btn-sm" disabled={busy || !adding.trim()} onClick={() => void add()}>
          {busy ? 'Blocking…' : 'Block this number'}
        </button>
      </div>
      {addError && <div className="alert alert-danger" style={{ marginTop: 'var(--space-2)' }}>{addError}</div>}

      {blocked === null ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>Loading…</p>
      ) : blocked.length === 0 ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>Nobody is blocked.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 'var(--space-4)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Number</th>
                <th style={thStyle}>Why</th>
                <th style={thStyle}>Blocked by</th>
                <th style={thStyle}>When</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {blocked.map((b) => (
                <tr key={b.phoneNumber}>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{b.phoneNumber}</td>
                  <td style={tdStyle}>{b.reason || <span style={{ color: 'var(--color-text-secondary)' }}>&mdash;</span>}</td>
                  <td style={tdStyle}>{b.blockedByName ?? <span style={{ color: 'var(--color-text-secondary)' }}>&mdash;</span>}</td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatDate(b.createdAt)}</td>
                  <td style={tdStyle}>
                    <button className="btn btn-secondary btn-sm" onClick={() => void remove(b.phoneNumber)}>
                      Unblock
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Deletes one voicemail recording, from Twilio and from the site's own log.
//
// The route has existed since 0.1.31 and nothing had ever called it, so a
// voicemail could be listened to and never got rid of. It asks first - in the
// button itself rather than a browser box - because the recording is gone from
// Twilio too and there is no getting it back.
function DeleteVoicemailButton({ sid, phoneNumber, onDeleted }: {
  sid: string
  phoneNumber: string
  onDeleted: () => void
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function remove() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(
        `/api/m/twilio/admin/voicemails/${sid}?number=${encodeURIComponent(phoneNumber)}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        setError((await response.json().catch(() => null))?.error ?? 'That did not work.')
        setAsking(false)
        return
      }
      onDeleted()
    } catch {
      setError('The site could not be reached.')
      setAsking(false)
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-destructive-hover)' }} role="alert">
        {error}
      </span>
    )
  }

  if (!asking) {
    return (
      <button className="btn btn-secondary btn-sm" onClick={() => setAsking(true)}>
        Delete
      </button>
    )
  }

  return (
    <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
        Delete for good?
      </span>
      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void remove()}>
        {busy ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setAsking(false)}>
        Keep it
      </button>
    </span>
  )
}

// `phoneNumber` rides along to the recording proxy: a recording lives in the
// Twilio region its call was processed in, and the recording SID alone does not
// say which that was.
function CallLogCard({ calls, loading, error, phoneNumber, blockedNumbers, onBlockedChanged, onVoicemailDeleted }: {
  calls: CallLogEntry[] | null
  loading: boolean
  error: string
  phoneNumber: string
  /** Who is blocked right now, so each row can offer the right one of Block and
   *  Unblock rather than guessing. Null while it is still being read. */
  blockedNumbers: Set<string> | null
  onBlockedChanged: () => Promise<void> | void
  onVoicemailDeleted: () => Promise<void> | void
}) {
  const [playingSid, setPlayingSid] = useState('')

  return (
    <div className="card">
      <h2 className="card-title">Call log</h2>

      {error && <div className="alert alert-danger">{error}</div>}

      {loading ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>Loading calls…</p>
      ) : !calls || calls.length === 0 ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>No calls on this number yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>When</th>
                <th style={thStyle}>Direction</th>
                <th style={thStyle}>From</th>
                <th style={thStyle}>To</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Length</th>
                <th style={thStyle}>Recording</th>
                <th style={thStyle}>Caller</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.sid}>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatDate(c.startTime)}</td>
                  <td style={tdStyle}><DirectionBadge direction={c.direction} /></td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{c.from}</td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{c.to}</td>
                  <td style={tdStyle}>{c.status}</td>
                  <td style={tdStyle}>{formatDuration(c.durationSeconds)}</td>
                  <td style={tdStyle}>
                    {c.recordingSids.length === 0 ? (
                      <span style={{ color: 'var(--color-text-secondary)' }}>—</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                        {c.recordingSids.map((sid) => (
                          <div
                            key={sid}
                            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
                          >
                            {playingSid === sid ? (
                              <audio
                                controls
                                autoPlay
                                preload="none"
                                src={`/api/m/twilio/admin/recordings/${sid}?number=${encodeURIComponent(phoneNumber)}`}
                                style={{ height: '2rem', maxWidth: '16rem' }}
                              />
                            ) : (
                              <button className="btn btn-secondary btn-sm" onClick={() => setPlayingSid(sid)}>
                                Listen
                              </button>
                            )}
                            {c.voicemailSids.includes(sid) && <VoicemailBadge />}
                            {/* Only voicemail can be deleted. A recording of a
                                call somebody answered is governed by the
                                account's own retention, not by this button. */}
                            {c.voicemailSids.includes(sid) && (
                              <DeleteVoicemailButton
                                sid={sid}
                                phoneNumber={phoneNumber}
                                onDeleted={() => void onVoicemailDeleted()}
                              />
                            )}
                            {c.transcriptions?.[sid] && (
                              <p
                                style={{
                                  flexBasis: '100%',
                                  margin: 0,
                                  fontSize: 'var(--text-sm)',
                                  color: 'var(--color-text-secondary)',
                                  maxWidth: '28rem',
                                }}
                              >
                                {c.transcriptions[sid].status === 'completed'
                                  ? <>&ldquo;{c.transcriptions[sid].text}&rdquo;</>
                                  : c.transcriptions[sid].status === 'pending'
                                    ? 'Transcription on its way…'
                                    : 'Twilio could not make out this message.'}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {/* The outside party, whichever end of the call they were
                        on: the person to block is never the site's own number. */}
                    <CallerCell
                      party={c.direction === 'inbound' ? c.from : c.to}
                      blocked={blockedNumbers?.has(c.direction === 'inbound' ? c.from : c.to) ?? false}
                      onChanged={onBlockedChanged}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MessageLogCard({ messages, loading, error }: { messages: MessageLogEntry[] | null; loading: boolean; error: string }) {
  return (
    <div className="card">
      <h2 className="card-title">Message log</h2>

      {error && <div className="alert alert-danger">{error}</div>}

      {loading ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>Loading messages…</p>
      ) : !messages || messages.length === 0 ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>No text messages on this number yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>When</th>
                <th style={thStyle}>Direction</th>
                <th style={thStyle}>From</th>
                <th style={thStyle}>To</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Message</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.sid}>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatDate(m.dateSent)}</td>
                  <td style={tdStyle}><DirectionBadge direction={m.direction} /></td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{m.from}</td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{m.to}</td>
                  <td style={tdStyle}>{m.status}</td>
                  <td style={{ ...tdStyle, minWidth: '16rem', overflowWrap: 'anywhere' }}>{m.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

type NumberLogs = {
  calls: CallLogEntry[] | null
  callsError: string
  messages: MessageLogEntry[] | null
  messagesError: string
}

export default function TwilioAdminScreen() {
  const [numbers, setNumbers] = useState<NumberRow[]>([])
  const [loading, setLoading] = useState(true)
  const [notConfigured, setNotConfigured] = useState(false)
  const [error, setError] = useState('')
  const [activeSid, setActiveSid] = useState('')
  const [logsByNumber, setLogsByNumber] = useState<Record<string, NumberLogs>>({})
  // Read once for the whole screen rather than per tab: the list is short, it is
  // the same list for every number on the account, and the call log needs to
  // know about it on every row.
  const [blocked, setBlocked] = useState<BlockedRow[] | null>(null)
  const [blockedError, setBlockedError] = useState('')

  const loadBlocked = useCallback(async () => {
    try {
      const response = await fetch('/api/m/twilio/admin/blocked-numbers')
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setBlockedError(body?.error ?? 'The blocked callers could not be read.')
        setBlocked([])
        return
      }
      setBlockedError('')
      setBlocked(body.blocked ?? [])
    } catch {
      setBlockedError('The site could not be reached.')
      setBlocked([])
    }
  }, [])

  const loadLogs = useCallback((phoneNumber: string) => {
    setLogsByNumber((prev) => ({
      ...prev,
      [phoneNumber]: { calls: null, callsError: '', messages: null, messagesError: '' },
    }))
    const q = encodeURIComponent(phoneNumber)
    fetch(`/api/m/twilio/admin/calls?number=${q}`)
      .then(async (res) => {
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'Failed to load calls')
        setLogsByNumber((prev) => ({
          ...prev,
          [phoneNumber]: { ...prev[phoneNumber]!, calls: d.calls },
        }))
      })
      .catch((err: unknown) =>
        setLogsByNumber((prev) => ({
          ...prev,
          [phoneNumber]: { ...prev[phoneNumber]!, calls: [], callsError: err instanceof Error ? err.message : 'Failed to load calls' },
        }))
      )
    fetch(`/api/m/twilio/admin/messages?number=${q}`)
      .then(async (res) => {
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'Failed to load messages')
        setLogsByNumber((prev) => ({
          ...prev,
          [phoneNumber]: { ...prev[phoneNumber]!, messages: d.messages },
        }))
      })
      .catch((err: unknown) =>
        setLogsByNumber((prev) => ({
          ...prev,
          [phoneNumber]: { ...prev[phoneNumber]!, messages: [], messagesError: err instanceof Error ? err.message : 'Failed to load messages' },
        }))
      )
  }, [])

  useEffect(() => {
    fetch('/api/m/twilio/admin/numbers')
      .then(async (res) => {
        const d = await res.json()
        if (res.status === 503) {
          setNotConfigured(true)
          return
        }
        if (!res.ok) throw new Error(d.error ?? 'Failed to load numbers')
        setNumbers(d.numbers)
        if (d.numbers.length > 0) {
          // A refresh comes back to the number you were reading, if it is still
          // on the account; otherwise the first one, as before.
          const wanted = new URLSearchParams(window.location.search).get('number')
          const opening = d.numbers.find((n: NumberRow) => n.sid === wanted) ?? d.numbers[0]
          setActiveSid(opening.sid)
          loadLogs(opening.phoneNumber)
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load numbers'))
      .finally(() => setLoading(false))
    // The blocked list is the same for every number on the account, so it is
    // read once here rather than again on each tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadBlocked awaits fetch before it touches state, so nothing is set synchronously
    void loadBlocked()
  }, [loadLogs, loadBlocked])

  const active = numbers.find((n) => n.sid === activeSid)

  // Lazy-load a number's logs the first time its tab is opened, and keep which
  // number is open in the URL so a refresh does not send you back to the first.
  function openTab(n: NumberRow) {
    setActiveSid(n.sid)
    setTabParam('number', n.sid)
    if (!logsByNumber[n.phoneNumber]) loadLogs(n.phoneNumber)
  }

  if (loading) return <p style={{ color: 'var(--color-text-secondary)' }}>Loading numbers…</p>

  if (notConfigured) {
    return (
      <div className="alert alert-warning">
        Twilio is not configured yet. Add your credentials on the Settings page (Twilio tab),
        redeploy, then come back here.
      </div>
    )
  }

  if (error) return <div className="alert alert-danger">{error}</div>

  if (numbers.length === 0) {
    return (
      <p style={{ color: 'var(--color-text-secondary)' }}>
        No phone numbers found on this Twilio account. Buy one in the Twilio console first,
        then come back here.
      </p>
    )
  }

  const logs = active ? logsByNumber[active.phoneNumber] : undefined

  return (
    <div>
      <TabStrip
        items={numbers.map((n) => ({
          key: n.sid,
          label: n.friendlyName && n.friendlyName !== n.phoneNumber
            ? `${n.phoneNumber} · ${n.friendlyName}`
            : n.phoneNumber,
          active: n.sid === activeSid,
          onClick: () => openTab(n),
        }))}
        trailing={active && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => loadLogs(active.phoneNumber)}
            disabled={!logs || logs.calls === null || logs.messages === null}
          >
            Refresh
          </button>
        )}
      />

      {active && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <MakeCallCard fromNumber={active.phoneNumber} />
          <CallLogCard
            calls={logs?.calls ?? null}
            loading={!logs || logs.calls === null}
            error={logs?.callsError ?? ''}
            phoneNumber={active.phoneNumber}
            blockedNumbers={blocked === null ? null : new Set(blocked.map((b) => b.phoneNumber))}
            onBlockedChanged={loadBlocked}
            onVoicemailDeleted={() => loadLogs(active.phoneNumber)}
          />
          <BlockedCallersCard blocked={blocked} error={blockedError} onChanged={loadBlocked} />
          <MessageLogCard
            messages={logs?.messages ?? null}
            loading={!logs || logs.messages === null}
            error={logs?.messagesError ?? ''}
          />
        </div>
      )}
    </div>
  )
}
