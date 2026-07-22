'use client'

// Call handling configuration - the "Call handling" sub-tab of the Twilio
// settings tab. One number is edited at a time, picked from a strip along the
// top, instead of every number's full form stacked into one endless scroll.
// Within a number the controls group into Forwarding, Voicemail and Opening
// hours sections. Edits are kept per number, so switching numbers does not
// lose unsaved work - the strip marks a number with unsaved changes.
import { useEffect, useState } from 'react'
import { TabStrip } from '@/components/admin/TabStrip'
import { TWILIO_VOICES, voiceAvailableInRegion, voiceForRegion } from '@/modules/twilio/lib/voices'
import {
  defaultBusinessHours,
  isValidHolidayDate,
  MIN_RING_TIMEOUT,
  MAX_RING_TIMEOUT,
  type BusinessHours,
} from '@/modules/twilio/lib/business-hours'

// An uploaded greeting audio file on a rule. `pending` marks one uploaded in
// this session but not yet saved onto the rule - the public audio route only
// serves ids a saved rule references, so the inline player waits for the save.
type AudioValue = { id: string; name: string | null; pending?: boolean } | null

type NumberRow = {
  sid: string
  phoneNumber: string
  friendlyName: string
  voiceUrl: string
  /** The Twilio Region this number's calls are processed in; null = unknown. */
  region: string | null
  greetingAudio: AudioValue
  voicemailAudio: AudioValue
  closedVoicemailAudio: AudioValue
  forwardTo: string
  forwardToSecond: string
  forwardingEnabled: boolean
  greetingMessage: string
  greetingVoice: string
  recordCalls: boolean
  showCalledNumber: boolean
  voicemailEnabled: boolean
  ringTimeout: number
  voicemailGreeting: string
  closedVoicemailGreeting: string
  voicemailVoice: string
  businessHours: BusinessHours
  holidayDates: string[]
  missedCallSmsEnabled: boolean
  missedCallSmsMessage: string
  transcribeVoicemail: boolean
  anonymousCallers: 'allow' | 'voicemail' | 'reject'
}

const VOICE_GROUPS = [...new Set(TWILIO_VOICES.map((v) => v.group))]

// Monday first for the picker; the stored day numbers keep Sunday at 0.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const checkboxLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  cursor: 'pointer',
  color: 'var(--color-text)',
  margin: 0,
}

const sectionBox: React.CSSProperties = {
  borderTop: '1px solid var(--color-border)',
  paddingTop: 'var(--space-4)',
  marginTop: 'var(--space-4)',
}

const sectionHeading: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--color-text)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  margin: '0 0 var(--space-3)',
}

const hint: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text-muted)',
}

// "2026-12-25" as "Fri 25 Dec 2026". Parsed as UTC and formatted in UTC, so a
// date-only string cannot slide a day either way on a browser west of London.
function formatHolidayDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

// Voice choices, constrained by where the number's calls are processed: some
// voices only exist for US-handled calls (voices.ts, usOnly), so on a number
// handled elsewhere those options are disabled and say so. A saved voice that
// is no longer sayable gets an honest note underneath naming the voice callers
// will actually hear - the webhook swaps it at call time rather than letting
// the call die. An unknown region (null) disables nothing.
function VoicePicker({
  value,
  region,
  onChange,
}: {
  value: string
  region: string | null
  onChange: (v: string) => void
}) {
  const unavailable = (id: string) => region !== null && !voiceAvailableInRegion(id, region)
  const substitute = region !== null && unavailable(value) ? voiceForRegion(value, region) : null
  const substituteLabel =
    substitute !== null
      ? TWILIO_VOICES.find((v) => v.id === substitute)?.label ?? 'the standard voice'
      : null
  return (
    <>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {VOICE_GROUPS.map((group) =>
          group === 'Default' ? (
            TWILIO_VOICES.filter((v) => v.group === group).map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))
          ) : (
            <optgroup key={group} label={group}>
              {TWILIO_VOICES.filter((v) => v.group === group).map((v) => (
                <option key={v.id} value={v.id} disabled={unavailable(v.id) && v.id !== value}>
                  {v.label}{unavailable(v.id) ? ' - United States numbers only' : ''}
                </option>
              ))}
            </optgroup>
          )
        )}
      </select>
      {substituteLabel && (
        <p style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          This voice only works on numbers handled in the United States, so callers to this
          number will hear {substituteLabel} instead. Pick a different voice to choose for
          yourself.
        </p>
      )}
    </>
  )
}

const AUDIO_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,.mp3,.wav'

// Upload-or-show control for one greeting slot's audio file. With no file, a
// picker that uploads on choose (MP3/WAV, filed in the media library's twilio
// folder); with one, its name, a player (once saved - see AudioValue.pending)
// and a Remove button. The greeting text/voice stay editable underneath but
// the audio wins on a real call, and the caption says so.
function GreetingAudioControl({
  label,
  value,
  disabled,
  onChange,
  onError,
}: {
  label: string
  value: AudioValue
  disabled: boolean
  onChange: (v: AudioValue) => void
  onError: (message: string) => void
}) {
  const [uploading, setUploading] = useState(false)

  async function upload(file: File) {
    setUploading(true)
    onError('')
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch('/api/m/twilio/admin/greeting-audio', { method: 'POST', body })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to upload the audio file')
      onChange({ id: d.mediaId, name: d.name, pending: true })
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Failed to upload the audio file')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="field" style={{ margin: 0, flex: '1 1 16rem' }}>
      <label>{label}</label>
      {value ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
            {value.name ?? 'audio file'}
          </span>
          {value.pending ? (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              uploaded - press Save to put it live
            </span>
          ) : (
            <audio
              controls
              preload="none"
              src={`/api/m/twilio/public/audio/${encodeURIComponent(value.id)}`}
              style={{ height: '2rem', maxWidth: '14rem' }}
            />
          )}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            Remove
          </button>
        </div>
      ) : (
        <input
          type="file"
          accept={AUDIO_ACCEPT}
          disabled={disabled || uploading}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void upload(file)
          }}
        />
      )}
      {value && (
        <p style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          Callers hear this recording instead of the typed message and voice.
        </p>
      )}
      {uploading && (
        <p style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          Uploading…
        </p>
      )}
    </div>
  )
}

// Bank-holiday importer: pick a country, see the public holidays falling in
// the next twelve months, tick the ones that apply and add them to the
// number's list. Twelve months rather than a calendar year, so an import in
// October reaches next spring instead of offering last January. The dates are
// only ever offered, never added on the admin's behalf - plenty of businesses
// work Boxing Day, and the site is in no position to know.
function HolidayImporter({
  existing,
  onAdd,
}: {
  existing: string[]
  onAdd: (dates: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [regions, setRegions] = useState<{ id: string; label: string }[] | null>(null)
  const [region, setRegion] = useState('')
  const [found, setFound] = useState<{ from: string; to: string; holidays: { date: string; name: string }[] } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // The country list comes from the route so it lives in one place.
  useEffect(() => {
    if (!open || regions) return
    fetch('/api/m/twilio/admin/holidays')
      .then(async (res) => {
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'Failed to load the country list')
        setRegions(d.regions)
        setRegion((r) => r || d.regions[0]?.id || '')
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load the country list'))
  }, [open, regions])

  async function lookUpHolidays() {
    setLoading(true)
    setError('')
    setFound(null)
    setPicked(new Set())
    try {
      const res = await fetch(`/api/m/twilio/admin/holidays?region=${encodeURIComponent(region)}`)
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to fetch the holiday list')
      setFound(d)
      // Everything not already on the list starts ticked: adding the lot is
      // the common case, and unticking the odd one is less work than ticking
      // eight.
      setPicked(new Set(d.holidays.filter((h: { date: string }) => !existing.includes(h.date)).map((h: { date: string }) => h.date)))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch the holiday list')
    } finally {
      setLoading(false)
    }
  }

  function toggle(date: string) {
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary"
        style={{ marginTop: 'var(--space-3)' }}
        onClick={() => setOpen(true)}
      >
        Import bank holidays
      </button>
    )
  }

  return (
    <div
      style={{
        marginTop: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-3)' }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="twilio-holiday-region">Country</label>
          <select
            id="twilio-holiday-region"
            value={region}
            disabled={!regions}
            onChange={(e) => { setRegion(e.target.value); setFound(null) }}
          >
            {(regions ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={loading || !region}
          onClick={lookUpHolidays}
        >
          {loading ? 'Looking them up…' : 'Look up the next 12 months'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginLeft: 'auto' }}
          onClick={() => { setOpen(false); setFound(null); setError('') }}
        >
          Close
        </button>
      </div>

      {error && <div className="alert alert-danger" style={{ marginTop: 'var(--space-3)' }}>{error}</div>}

      {found && (
        found.holidays.length === 0 ? (
          <p style={{ ...hint, marginTop: 'var(--space-3)' }}>
            No holidays listed for that country in the next twelve months.
          </p>
        ) : (
          <>
            <p style={{ ...hint, fontSize: 'var(--text-xs)', marginTop: 'var(--space-3)' }}>
              Holidays between {formatHolidayDate(found.from)} and {formatHolidayDate(found.to)}.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
              {found.holidays.map((h) => {
                const already = existing.includes(h.date)
                return (
                  <label
                    key={h.date}
                    style={{
                      ...checkboxLabel,
                      cursor: already ? 'default' : 'pointer',
                      color: already ? 'var(--color-text-muted)' : 'var(--color-text)',
                      fontSize: 'var(--text-sm)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={already || picked.has(h.date)}
                      disabled={already}
                      onChange={() => toggle(h.date)}
                    />
                    <span style={{ minWidth: '9rem' }}>{formatHolidayDate(h.date)}</span>
                    <span style={{ color: 'var(--color-text-muted)' }}>{h.name}</span>
                    {already && (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                        already added
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 'var(--space-3)' }}
              disabled={picked.size === 0}
              onClick={() => {
                onAdd([...picked])
                setPicked(new Set())
              }}
            >
              Add {picked.size} date{picked.size === 1 ? '' : 's'}
            </button>
          </>
        )
      )}

      <p style={{ ...hint, fontSize: 'var(--text-xs)', marginTop: 'var(--space-3)' }}>
        UK dates come from the government&apos;s own bank holiday list; Ireland and the United
        States from a public holiday service. Check them against your own plans before adding -
        plenty of businesses work the odd bank holiday. Come back in a year for the next lot.
      </p>
    </div>
  )
}

// One-off closed dates on top of the weekly schedule - a date picker, an Add
// button, the bank-holiday importer, and the saved list with a remove per date.
// Past dates can be cleared out but are harmless if left: they simply never
// match again.
function HolidayDatesControl({
  dates,
  onChange,
}: {
  dates: string[]
  onChange: (dates: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  function add() {
    if (!isValidHolidayDate(draft) || dates.includes(draft)) return
    onChange([...dates, draft].sort())
    setDraft('')
  }

  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-3)' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Closed on these dates (bank holidays and the like)</label>
          <input
            type="date"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={{ width: 'auto' }}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!isValidHolidayDate(draft) || dates.includes(draft)}
          onClick={add}
        >
          Add date
        </button>
      </div>

      <HolidayImporter existing={dates} onAdd={(added) => onChange([...new Set([...dates, ...added])].sort())} />
      {dates.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
          {dates.map((date) => (
            <span
              key={date}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--space-1) var(--space-2)',
              }}
            >
              {formatHolidayDate(date)}
              <button
                type="button"
                aria-label={`Remove ${date}`}
                onClick={() => onChange(dates.filter((d) => d !== date))}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: 'var(--color-text-muted)',
                  padding: 0,
                  fontSize: 'var(--text-sm)',
                  lineHeight: 1,
                }}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
      <p style={{ ...hint, fontSize: 'var(--text-xs)', marginTop: 'var(--space-2)' }}>
        On these dates the number is closed all day, whatever the weekly hours say.
      </p>
    </div>
  )
}

export function TwilioForwardingSection() {
  const [numbers, setNumbers] = useState<NumberRow[]>([])
  const [loading, setLoading] = useState(true)
  const [notConfigured, setNotConfigured] = useState(false)
  const [error, setError] = useState('')
  const [selectedSid, setSelectedSid] = useState('')
  const [dirtySids, setDirtySids] = useState<Set<string>>(new Set())
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
        if (d.numbers.length > 0) setSelectedSid((sid) => sid || d.numbers[0].sid)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load numbers'))
      .finally(() => setLoading(false))
  }, [])

  function updateRow(sid: string, patch: Partial<NumberRow>) {
    setNumbers((rows) => rows.map((r) => (r.sid === sid ? { ...r, ...patch } : r)))
    setDirtySids((s) => new Set(s).add(sid))
    if (savedSid === sid) setSavedSid('')
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
          forwardToSecond: row.forwardToSecond,
          enabled: row.forwardingEnabled,
          greetingMessage: row.greetingMessage,
          greetingVoice: row.greetingVoice,
          recordCalls: row.recordCalls,
          showCalledNumber: row.showCalledNumber,
          voicemailEnabled: row.voicemailEnabled,
          ringTimeout: row.ringTimeout,
          voicemailGreeting: row.voicemailGreeting,
          closedVoicemailGreeting: row.closedVoicemailGreeting,
          voicemailVoice: row.voicemailVoice,
          businessHours: row.businessHours,
          holidayDates: row.holidayDates,
          missedCallSmsEnabled: row.missedCallSmsEnabled,
          missedCallSmsMessage: row.missedCallSmsMessage,
          transcribeVoicemail: row.transcribeVoicemail,
          anonymousCallers: row.anonymousCallers,
          greetingAudioMediaId: row.greetingAudio?.id ?? '',
          voicemailAudioMediaId: row.voicemailAudio?.id ?? '',
          closedVoicemailAudioMediaId: row.closedVoicemailAudio?.id ?? '',
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      setSavedSid(row.sid)
      setDirtySids((s) => {
        const next = new Set(s)
        next.delete(row.sid)
        return next
      })
      // Saved audio is now served by the public route, so the inline players
      // can appear.
      const settled = (v: AudioValue): AudioValue => (v ? { ...v, pending: false } : null)
      setNumbers((rows) =>
        rows.map((r) =>
          r.sid === row.sid
            ? {
                ...r,
                greetingAudio: settled(row.greetingAudio),
                voicemailAudio: settled(row.voicemailAudio),
                closedVoicemailAudio: settled(row.closedVoicemailAudio),
              }
            : r
        )
      )
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

  const row = numbers.find((n) => n.sid === selectedSid) ?? null

  return (
    <div className="card">
      <h2 className="card-title">Call handling</h2>
      <p style={{ ...hint, margin: '0 0 var(--space-4)' }}>
        Choose where each of your Twilio numbers forwards incoming calls, and what happens when
        nobody picks up. With forwarding and voicemail both off, the number reverts to whatever
        it did before. Saving here wires the number up at Twilio automatically - there&apos;s
        nothing to configure in the Twilio console. If you do go looking there, flip the
        console&apos;s region switcher (top right) to the same country the number is handled in:
        each country keeps its own copy of a number&apos;s call settings, so the wrong
        country&apos;s page just looks empty.
      </p>

      {error && <div className="alert alert-danger">{error}</div>}

      {notConfigured ? (
        <div className="alert alert-warning">
          Twilio is not configured yet. Add your credentials on the Account tab, redeploy, then come back here.
        </div>
      ) : loading ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Loading numbers…</p>
      ) : numbers.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No phone numbers found on this Twilio account.</p>
      ) : (
        <>
          {numbers.length > 1 && (
            <TabStrip
              style={{ marginBottom: 'var(--space-4)' }}
              items={numbers.map((n) => ({
                key: n.sid,
                label: dirtySids.has(n.sid) ? `${n.phoneNumber} •` : n.phoneNumber,
                active: n.sid === selectedSid,
                onClick: () => setSelectedSid(n.sid),
              }))}
            />
          )}

          {row && (
            <div key={row.sid}>
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <div style={{ fontWeight: 'var(--font-semibold)', color: 'var(--color-text)' }}>{row.phoneNumber}</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{row.friendlyName}</div>
              </div>

              {/* ---------------- Forwarding ---------------- */}
              <h3 style={sectionHeading}>Forwarding</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-4)' }}>
                <div className="field" style={{ margin: 0, flex: '1 1 14rem' }}>
                  <label>Forward calls to</label>
                  <input
                    type="tel"
                    value={row.forwardTo}
                    placeholder="+447700900123"
                    onChange={(e) => updateRow(row.sid, { forwardTo: e.target.value })}
                  />
                </div>
                <div className="field" style={{ margin: 0, flex: '1 1 14rem' }}>
                  <label>If nobody answers, also try (optional)</label>
                  <input
                    type="tel"
                    value={row.forwardToSecond}
                    placeholder="+447700900456"
                    onChange={(e) => updateRow(row.sid, { forwardToSecond: e.target.value })}
                  />
                </div>
                <label style={{ ...checkboxLabel, paddingBottom: 'var(--space-2)' }}>
                  <input
                    type="checkbox"
                    checked={row.forwardingEnabled}
                    onChange={(e) => updateRow(row.sid, { forwardingEnabled: e.target.checked })}
                  />
                  Forwarding on
                </label>
              </div>
              {row.forwardToSecond.trim() !== '' && (
                <p style={{ ...hint, marginTop: 'var(--space-2)' }}>
                  The second number rings for the same length of time as the first, then the call
                  goes to voicemail (if it&apos;s on) or ends.
                </p>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
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
                    region={row.region}
                    onChange={(v) => updateRow(row.sid, { greetingVoice: v })}
                  />
                </div>
                <GreetingAudioControl
                  label="Or upload a recording (MP3 or WAV)"
                  value={row.greetingAudio}
                  disabled={savingSid === row.sid}
                  onChange={(v) => updateRow(row.sid, { greetingAudio: v })}
                  onError={setError}
                />
              </div>
              {row.greetingMessage.trim() && !row.greetingAudio && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
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
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
                <label style={checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={row.recordCalls}
                    onChange={(e) => updateRow(row.sid, { recordCalls: e.target.checked })}
                  />
                  Record calls
                </label>
                <label style={checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={row.showCalledNumber}
                    onChange={(e) => updateRow(row.sid, { showCalledNumber: e.target.checked })}
                  />
                  Show this number as caller ID
                </label>
              </div>
              {row.showCalledNumber && (
                <p style={{ ...hint, marginTop: 'var(--space-2)' }}>
                  Forwarded calls will display {row.phoneNumber} instead of the caller&apos;s own
                  number - handy for knowing it came through this line, but you won&apos;t see who
                  actually rang until you answer.
                </p>
              )}
              {row.recordCalls && (
                <p style={{ ...hint, marginTop: 'var(--space-2)' }}>
                  Recordings live in your Twilio account and can be played back from the call
                  log on the Twilio page. Telling callers they are being recorded is your
                  responsibility - the greeting above is a handy place to do it.
                </p>
              )}
              <div className="field" style={{ margin: 'var(--space-4) 0 0', maxWidth: '24rem' }}>
                <label>Callers who withhold their number</label>
                <select
                  value={row.anonymousCallers}
                  onChange={(e) => updateRow(row.sid, { anonymousCallers: e.target.value as NumberRow['anonymousCallers'] })}
                >
                  <option value="allow">Ring through like anyone else</option>
                  <option value="voicemail">Straight to voicemail</option>
                  <option value="reject">Reject the call</option>
                </select>
                {row.anonymousCallers === 'voicemail' && !row.voicemailEnabled && (
                  <p style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                    Voicemail is off below, so withheld numbers will be rejected instead until
                    it&apos;s switched on.
                  </p>
                )}
              </div>

              {/* ---------------- Missed-call text ---------------- */}
              <div style={sectionBox}>
                <h3 style={sectionHeading}>Missed calls</h3>
                <label style={checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={row.missedCallSmsEnabled}
                    onChange={(e) => updateRow(row.sid, { missedCallSmsEnabled: e.target.checked })}
                  />
                  Text the caller back when nobody answers
                </label>
                {row.missedCallSmsEnabled && (
                  <div className="field" style={{ margin: 'var(--space-3) 0 0', maxWidth: '32rem' }}>
                    <label>The message</label>
                    <textarea
                      rows={2}
                      maxLength={320}
                      value={row.missedCallSmsMessage}
                      placeholder="Sorry we missed your call - we will ring you back as soon as we can."
                      onChange={(e) => updateRow(row.sid, { missedCallSmsMessage: e.target.value })}
                    />
                    <p style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                      Sent from this number where it can text, otherwise from the site&apos;s usual
                      texting number. Callers who withheld their number can&apos;t be texted back.
                    </p>
                  </div>
                )}
              </div>

              {/* ---------------- Voicemail ---------------- */}
              <div style={sectionBox}>
                <h3 style={sectionHeading}>Voicemail</h3>
                <label style={checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={row.voicemailEnabled}
                    onChange={(e) => updateRow(row.sid, { voicemailEnabled: e.target.checked })}
                  />
                  Take a voicemail when nobody answers
                </label>

                {row.voicemailEnabled && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
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
                      <p style={{ ...hint, flexBasis: '100%' }}>
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
                        region={row.region}
                        onChange={(v) => updateRow(row.sid, { voicemailVoice: v })}
                      />
                    </div>
                    <GreetingAudioControl
                      label="Or upload a recording (MP3 or WAV)"
                      value={row.voicemailAudio}
                      disabled={savingSid === row.sid}
                      onChange={(v) => updateRow(row.sid, { voicemailAudio: v })}
                      onError={setError}
                    />
                    {row.voicemailGreeting.trim() && !row.voicemailAudio && (
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
                    <label style={{ ...checkboxLabel, flexBasis: '100%' }}>
                      <input
                        type="checkbox"
                        checked={row.transcribeVoicemail}
                        onChange={(e) => updateRow(row.sid, { transcribeVoicemail: e.target.checked })}
                      />
                      Type messages up for me (transcription)
                    </label>
                    {row.transcribeVoicemail && (
                      <p style={{ ...hint, flexBasis: '100%', fontSize: 'var(--text-xs)' }}>
                        The words appear in the call log a few minutes after the message, next to
                        the recording. Twilio&apos;s typing-up is English-only and does its best -
                        mumbling is between the caller and their conscience.
                      </p>
                    )}
                    <p style={{ ...hint, flexBasis: '100%' }}>
                      Messages can run to two minutes and land in the call log on the Twilio page,
                      alongside your recordings.
                    </p>
                  </div>
                )}
              </div>

              {/* ---------------- Opening hours ---------------- */}
              <div style={sectionBox}>
                <h3 style={sectionHeading}>Opening hours</h3>
                <label style={checkboxLabel}>
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
                    <p style={{ ...hint, margin: 'var(--space-2) 0 var(--space-3)' }}>
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

                    <HolidayDatesControl
                      dates={row.holidayDates}
                      onChange={(dates) => updateRow(row.sid, { holidayDates: dates })}
                    />

                    {row.voicemailEnabled && (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'flex-end',
                          gap: 'var(--space-4)',
                          marginTop: 'var(--space-4)',
                        }}
                      >
                        <div className="field" style={{ margin: 0, flex: '2 1 20rem' }}>
                          <label htmlFor={`vm-closed-greeting-${row.sid}`}>
                            What callers hear when you&apos;re closed (optional)
                          </label>
                          <textarea
                            id={`vm-closed-greeting-${row.sid}`}
                            rows={2}
                            maxLength={500}
                            value={row.closedVoicemailGreeting}
                            placeholder="Thanks for calling. We're closed at the moment, but leave a message and we'll ring you back when we open."
                            onChange={(e) => updateRow(row.sid, { closedVoicemailGreeting: e.target.value })}
                          />
                        </div>
                        <GreetingAudioControl
                          label="Or upload a recording (MP3 or WAV)"
                          value={row.closedVoicemailAudio}
                          disabled={savingSid === row.sid}
                          onChange={(v) => updateRow(row.sid, { closedVoicemailAudio: v })}
                          onError={setError}
                        />
                        {row.closedVoicemailGreeting.trim() && !row.closedVoicemailAudio && (
                          <button
                            className="btn btn-secondary"
                            disabled={previewingSid === `${row.sid}:closed` || !previewTo}
                            onClick={() =>
                              previewGreeting(row, `${row.sid}:closed`, row.closedVoicemailGreeting, row.voicemailVoice)
                            }
                          >
                            {previewingSid === `${row.sid}:closed`
                              ? 'Calling…'
                              : previewCalledSid === `${row.sid}:closed`
                                ? 'Calling you now'
                                : 'Call me to hear it'}
                          </button>
                        )}
                        <p style={{ ...hint, flexBasis: '100%' }}>
                          Leave this empty and out-of-hours callers hear your usual voicemail
                          greeting instead. Same voice either way - only the words change.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={{ ...sectionBox, display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <button
                  className="btn btn-primary"
                  disabled={savingSid === row.sid || (row.forwardingEnabled && !row.forwardTo)}
                  onClick={() => saveRow(row)}
                >
                  {savingSid === row.sid ? 'Saving…' : savedSid === row.sid ? 'Saved' : 'Save'}
                </button>
                {dirtySids.has(row.sid) && (
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                    Unsaved changes
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
