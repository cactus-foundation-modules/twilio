'use client'

// Call forwarding configuration card - one row per Twilio incoming number.
// Lives on the core admin settings page (Twilio tab); the main Twilio admin
// page now holds the call and message logs instead.
import { useEffect, useState } from 'react'
import { TWILIO_VOICES } from '@/modules/twilio/lib/voices'
import {
  defaultBusinessHours,
  MIN_RING_TIMEOUT,
  MAX_RING_TIMEOUT,
  type BusinessHours,
} from '@/modules/twilio/lib/business-hours'

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
  voicemailEnabled: boolean
  ringTimeout: number
  voicemailGreeting: string
  voicemailVoice: string
  businessHours: BusinessHours
}

const VOICE_GROUPS = [...new Set(TWILIO_VOICES.map((v) => v.group))]

// Monday first for the picker; the stored day numbers keep Sunday at 0.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function VoicePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
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
  )
}

export function TwilioForwardingSection() {
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
          voicemailEnabled: row.voicemailEnabled,
          ringTimeout: row.ringTimeout,
          voicemailGreeting: row.voicemailGreeting,
          voicemailVoice: row.voicemailVoice,
          businessHours: row.businessHours,
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

  // Rings the admin and reads back whichever greeting they are editing - the
  // forwarding notice or the voicemail message. `key` keeps the two buttons on a
  // row telling the truth about which one is calling.
  async function previewGreeting(row: NumberRow, key: string, message: string, voice: string) {
    setPreviewingSid(key)
    setPreviewCalledSid('')
    setError('')
    try {
      const res = await fetch('/api/m/twilio/admin/greeting-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: row.phoneNumber,
          to: previewTo,
          greetingMessage: message,
          greetingVoice: voice,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to place preview call')
      setPreviewCalledSid(key)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to place preview call')
    } finally {
      setPreviewingSid('')
    }
  }

  function updateDay(row: NumberRow, day: number, patch: Partial<BusinessHours[number]>) {
    updateRow(row.sid, {
      businessHours: row.businessHours.map((h) => (h.day === day ? { ...h, ...patch } : h)),
    })
  }

  return (
    <div className="card">
      <h2 className="card-title">Call forwarding</h2>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
        Choose where each of your Twilio numbers forwards incoming calls, and what happens when
        nobody picks up. With forwarding and voicemail both off, the number reverts to whatever
        it did before.
      </p>

      {error && <div className="alert alert-danger">{error}</div>}

      {notConfigured ? (
        <div className="alert alert-warning">
          Twilio is not configured yet. Add your credentials above, redeploy, then come back here.
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
                  <VoicePicker
                    value={row.greetingVoice}
                    onChange={(v) => updateRow(row.sid, { greetingVoice: v })}
                  />
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
                    disabled={previewingSid === `${row.sid}:greeting` || !previewTo}
                    onClick={() => previewGreeting(row, `${row.sid}:greeting`, row.greetingMessage, row.greetingVoice)}
                  >
                    {previewingSid === `${row.sid}:greeting`
                      ? 'Calling…'
                      : previewCalledSid === `${row.sid}:greeting`
                        ? 'Calling you now'
                        : 'Call me to preview'}
                  </button>
                </div>
              )}
              {row.recordCalls && (
                <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                  Recordings live in your Twilio account and can be played back from the call
                  log on the Twilio page. Telling callers they are being recorded is your
                  responsibility - the greeting above is a handy place to do it.
                </p>
              )}
              <div
                style={{
                  flexBasis: '100%',
                  borderTop: '1px solid var(--color-border)',
                  paddingTop: 'var(--space-4)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                  gap: 'var(--space-4)',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', color: 'var(--color-text)', flexBasis: '100%' }}>
                  <input
                    type="checkbox"
                    checked={row.voicemailEnabled}
                    onChange={(e) => updateRow(row.sid, { voicemailEnabled: e.target.checked })}
                  />
                  Take a voicemail when nobody answers
                </label>

                {row.voicemailEnabled && (
                  <>
                    <div className="field" style={{ margin: 0, flex: '0 1 12rem' }}>
                      <label htmlFor={`ring-${row.sid}`}>Ring for (seconds) before voicemail</label>
                      <input
                        id={`ring-${row.sid}`}
                        type="number"
                        min={MIN_RING_TIMEOUT}
                        max={MAX_RING_TIMEOUT}
                        value={row.ringTimeout}
                        disabled={!row.forwardingEnabled}
                        onChange={(e) => updateRow(row.sid, { ringTimeout: Number(e.target.value) })}
                      />
                    </div>
                    {!row.forwardingEnabled && (
                      <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                        Forwarding is off, so there is nothing to ring - callers go straight to
                        voicemail.
                      </p>
                    )}
                    <div className="field" style={{ margin: 0, flex: '2 1 20rem' }}>
                      <label htmlFor={`vm-greeting-${row.sid}`}>What callers hear before the beep</label>
                      <textarea
                        id={`vm-greeting-${row.sid}`}
                        rows={2}
                        maxLength={500}
                        value={row.voicemailGreeting}
                        placeholder="Sorry, we can't take your call right now. Leave a message and we'll ring you back."
                        onChange={(e) => updateRow(row.sid, { voicemailGreeting: e.target.value })}
                      />
                    </div>
                    <div className="field" style={{ margin: 0, flex: '1 1 12rem' }}>
                      <label>Voicemail voice</label>
                      <VoicePicker
                        value={row.voicemailVoice}
                        onChange={(v) => updateRow(row.sid, { voicemailVoice: v })}
                      />
                    </div>
                    {row.voicemailGreeting.trim() && (
                      <button
                        className="btn btn-secondary"
                        disabled={previewingSid === `${row.sid}:voicemail` || !previewTo}
                        onClick={() => previewGreeting(row, `${row.sid}:voicemail`, row.voicemailGreeting, row.voicemailVoice)}
                      >
                        {previewingSid === `${row.sid}:voicemail`
                          ? 'Calling…'
                          : previewCalledSid === `${row.sid}:voicemail`
                            ? 'Calling you now'
                            : 'Call me to hear it'}
                      </button>
                    )}
                    <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                      Messages can run to two minutes and land in the call log on the Twilio page,
                      alongside your recordings.
                    </p>
                  </>
                )}
              </div>

              <div
                style={{
                  flexBasis: '100%',
                  borderTop: '1px solid var(--color-border)',
                  paddingTop: 'var(--space-4)',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', color: 'var(--color-text)' }}>
                  <input
                    type="checkbox"
                    checked={row.businessHours.length > 0}
                    onChange={(e) =>
                      updateRow(row.sid, { businessHours: e.target.checked ? defaultBusinessHours() : [] })
                    }
                  />
                  Only ring during opening hours
                </label>

                {row.businessHours.length > 0 && (
                  <>
                    <p style={{ margin: 'var(--space-2) 0 var(--space-3)', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                      Outside these hours the phone doesn&apos;t ring at all.{' '}
                      {row.voicemailEnabled
                        ? 'Callers go straight to voicemail.'
                        : 'Callers are turned away - switch voicemail on above if you would rather take a message.'}{' '}
                      Times follow your site&apos;s timezone, set on the General tab. A closing time
                      earlier than the opening one runs through midnight.
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                      {DAY_ORDER.map((day) => {
                        const entry = row.businessHours.find((h) => h.day === day)
                        if (!entry) return null
                        return (
                          <div
                            key={day}
                            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)' }}
                          >
                            <span style={{ minWidth: '6rem', color: 'var(--color-text)', fontSize: 'var(--text-sm)' }}>
                              {DAY_LABELS[day]}
                            </span>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                              <input
                                type="checkbox"
                                checked={!entry.closed}
                                onChange={(e) => updateDay(row, day, { closed: !e.target.checked })}
                              />
                              Open
                            </label>
                            <input
                              type="time"
                              aria-label={`${DAY_LABELS[day]} opening time`}
                              value={entry.open}
                              disabled={entry.closed}
                              onChange={(e) => updateDay(row, day, { open: e.target.value })}
                              style={{ width: 'auto' }}
                            />
                            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>to</span>
                            <input
                              type="time"
                              aria-label={`${DAY_LABELS[day]} closing time`}
                              value={entry.close}
                              disabled={entry.closed}
                              onChange={(e) => updateDay(row, day, { close: e.target.value })}
                              style={{ width: 'auto' }}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>

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
  )
}
