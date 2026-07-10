'use client'

import { useEffect, useState } from 'react'
import { TWILIO_VOICES } from '@/modules/twilio/lib/voices'

type NumberRow = {
  sid: string
  phoneNumber: string
  friendlyName: string
  voiceUrl: string
  forwardTo: string
  forwardingEnabled: boolean
  greetingMessage: string
  greetingVoice: string
  recordCalls: boolean
  showCalledNumber: boolean
}

const VOICE_GROUPS = [...new Set(TWILIO_VOICES.map((v) => v.group))]

export default function TwilioAdminScreen() {
  const [numbers, setNumbers] = useState<NumberRow[]>([])
  const [loading, setLoading] = useState(true)
  const [notConfigured, setNotConfigured] = useState(false)
  const [error, setError] = useState('')
  const [savingSid, setSavingSid] = useState('')
  const [savedSid, setSavedSid] = useState('')
  const [previewTo, setPreviewTo] = useState('')
  const [previewingSid, setPreviewingSid] = useState('')
  const [previewCalledSid, setPreviewCalledSid] = useState('')

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
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load numbers'))
      .finally(() => setLoading(false))
  }, [])

  function updateRow(sid: string, patch: Partial<NumberRow>) {
    setNumbers((rows) => rows.map((r) => (r.sid === sid ? { ...r, ...patch } : r)))
  }

  async function saveRow(row: NumberRow) {
    setSavingSid(row.sid)
    setSavedSid('')
    setError('')
    try {
      const res = await fetch('/api/m/twilio/admin/forwarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneSid: row.sid,
          phoneNumber: row.phoneNumber,
          forwardTo: row.forwardTo,
          enabled: row.forwardingEnabled,
          greetingMessage: row.greetingMessage,
          greetingVoice: row.greetingVoice,
          recordCalls: row.recordCalls,
          showCalledNumber: row.showCalledNumber,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      setSavedSid(row.sid)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingSid('')
    }
  }

  async function previewGreeting(row: NumberRow) {
    setPreviewingSid(row.sid)
    setPreviewCalledSid('')
    setError('')
    try {
      const res = await fetch('/api/m/twilio/admin/greeting-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: row.phoneNumber,
          to: previewTo,
          greetingMessage: row.greetingMessage,
          greetingVoice: row.greetingVoice,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to place preview call')
      setPreviewCalledSid(row.sid)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to place preview call')
    } finally {
      setPreviewingSid('')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="card">
        <h2 className="card-title">Call forwarding</h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
          Choose where each of your Twilio numbers forwards incoming calls. When forwarding is
          off, the number reverts to whatever it did before.
        </p>

        {error && <div className="alert alert-danger">{error}</div>}

        {notConfigured ? (
          <div className="alert alert-warning">
            Twilio is not configured yet. Add your credentials on the Settings page (Twilio tab),
            redeploy, then come back here.
          </div>
        ) : loading ? (
          <p style={{ color: 'var(--color-text-muted)' }}>Loading numbers…</p>
        ) : numbers.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)' }}>No phone numbers found on this Twilio account.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {numbers.map((row) => (
              <div
                key={row.sid}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                  gap: 'var(--space-4)',
                  padding: 'var(--space-4)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <div style={{ minWidth: '12rem' }}>
                  <div style={{ fontWeight: 'var(--font-semibold)', color: 'var(--color-text)' }}>{row.phoneNumber}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{row.friendlyName}</div>
                </div>
                <div className="field" style={{ margin: 0, flex: '1 1 14rem' }}>
                  <label>Forward calls to</label>
                  <input
                    type="tel"
                    value={row.forwardTo}
                    placeholder="+447700900123"
                    onChange={(e) => updateRow(row.sid, { forwardTo: e.target.value })}
                  />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', color: 'var(--color-text)', paddingBottom: 'var(--space-2)' }}>
                  <input
                    type="checkbox"
                    checked={row.forwardingEnabled}
                    onChange={(e) => updateRow(row.sid, { forwardingEnabled: e.target.checked })}
                  />
                  Forwarding on
                </label>
                <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-4)' }}>
                  <div className="field" style={{ margin: 0, flex: '2 1 20rem' }}>
                    <label>Greeting played before forwarding (optional)</label>
                    <textarea
                      rows={2}
                      maxLength={500}
                      value={row.greetingMessage}
                      placeholder="Thank you for calling. Calls are recorded."
                      onChange={(e) => updateRow(row.sid, { greetingMessage: e.target.value })}
                    />
                  </div>
                  <div className="field" style={{ margin: 0, flex: '1 1 12rem' }}>
                    <label>Greeting voice</label>
                    <select
                      value={row.greetingVoice}
                      onChange={(e) => updateRow(row.sid, { greetingVoice: e.target.value })}
                    >
                      {VOICE_GROUPS.map((group) =>
                        group === 'Default' ? (
                          TWILIO_VOICES.filter((v) => v.group === group).map((v) => (
                            <option key={v.id} value={v.id}>{v.label}</option>
                          ))
                        ) : (
                          <optgroup key={group} label={group}>
                            {TWILIO_VOICES.filter((v) => v.group === group).map((v) => (
                              <option key={v.id} value={v.id}>{v.label}</option>
                            ))}
                          </optgroup>
                        )
                      )}
                    </select>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', color: 'var(--color-text)', paddingBottom: 'var(--space-2)' }}>
                    <input
                      type="checkbox"
                      checked={row.recordCalls}
                      onChange={(e) => updateRow(row.sid, { recordCalls: e.target.checked })}
                    />
                    Record calls
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', color: 'var(--color-text)', paddingBottom: 'var(--space-2)' }}>
                    <input
                      type="checkbox"
                      checked={row.showCalledNumber}
                      onChange={(e) => updateRow(row.sid, { showCalledNumber: e.target.checked })}
                    />
                    Show this number as caller ID
                  </label>
                </div>
                {row.showCalledNumber && (
                  <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                    Forwarded calls will display {row.phoneNumber} instead of the caller&apos;s own
                    number - handy for knowing it came through this line, but you won&apos;t see who
                    actually rang until you answer.
                  </p>
                )}
                {row.greetingMessage.trim() && (
                  <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-4)' }}>
                    <div className="field" style={{ margin: 0, flex: '1 1 14rem' }}>
                      <label>Hear it first - we ring you and read it out</label>
                      <input
                        type="tel"
                        value={previewTo}
                        placeholder="+447700900123"
                        onChange={(e) => setPreviewTo(e.target.value)}
                      />
                    </div>
                    <button
                      className="btn btn-secondary"
                      disabled={previewingSid === row.sid || !previewTo}
                      onClick={() => previewGreeting(row)}
                    >
                      {previewingSid === row.sid ? 'Calling…' : previewCalledSid === row.sid ? 'Calling you now' : 'Call me to preview'}
                    </button>
                  </div>
                )}
                {row.recordCalls && (
                  <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                    Recordings are kept in your Twilio console, not on this site. Telling callers
                    they are being recorded is your responsibility - the greeting above is a handy
                    place to do it.
                  </p>
                )}
                <button
                  className="btn btn-primary"
                  disabled={savingSid === row.sid || (row.forwardingEnabled && !row.forwardTo)}
                  onClick={() => saveRow(row)}
                >
                  {savingSid === row.sid ? 'Saving…' : savedSid === row.sid ? 'Saved' : 'Save'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
