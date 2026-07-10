'use client'

// Main Twilio admin page: one tab per phone number on the account, each with
// a click-to-dial card, the number's call log (with recording playback) and
// its text message log. Forwarding configuration lives on the core settings
// page (Twilio tab).
import { useCallback, useEffect, useState } from 'react'
import { TabStrip } from '@/components/admin/TabStrip'

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
  color: 'var(--color-text-muted)',
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
        color: 'var(--color-text-muted)',
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
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
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

function CallLogCard({ calls, loading, error }: { calls: CallLogEntry[] | null; loading: boolean; error: string }) {
  const [playingSid, setPlayingSid] = useState('')

  return (
    <div className="card">
      <h2 className="card-title">Call log</h2>

      {error && <div className="alert alert-danger">{error}</div>}

      {loading ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Loading calls…</p>
      ) : !calls || calls.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No calls on this number yet.</p>
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
                      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                        {c.recordingSids.map((sid) =>
                          playingSid === sid ? (
                            <audio
                              key={sid}
                              controls
                              autoPlay
                              preload="none"
                              src={`/api/m/twilio/admin/recordings/${sid}`}
                              style={{ height: '2rem', maxWidth: '16rem' }}
                            />
                          ) : (
                            <button
                              key={sid}
                              className="btn btn-secondary btn-sm"
                              onClick={() => setPlayingSid(sid)}
                            >
                              Listen
                            </button>
                          )
                        )}
                      </div>
                    )}
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
        <p style={{ color: 'var(--color-text-muted)' }}>Loading messages…</p>
      ) : !messages || messages.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No text messages on this number yet.</p>
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
          setActiveSid(d.numbers[0].sid)
          loadLogs(d.numbers[0].phoneNumber)
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load numbers'))
      .finally(() => setLoading(false))
  }, [loadLogs])

  const active = numbers.find((n) => n.sid === activeSid)

  // Lazy-load a number's logs the first time its tab is opened.
  function openTab(n: NumberRow) {
    setActiveSid(n.sid)
    if (!logsByNumber[n.phoneNumber]) loadLogs(n.phoneNumber)
  }

  if (loading) return <p style={{ color: 'var(--color-text-muted)' }}>Loading numbers…</p>

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
      <p style={{ color: 'var(--color-text-muted)' }}>
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
          />
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
