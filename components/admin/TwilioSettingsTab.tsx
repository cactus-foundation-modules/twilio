'use client'

// "Twilio" tab on the core admin settings page (settingsTabs manifest entry).
// Credentials are stored as environment variables through the core-managed
// /api/admin/env route (declared via this module's requiredEnvVars). Phone
// numbers are picked from the connected account rather than typed in - texts
// only ever go out from a text-capable number the admin has added to the site.
import { useEffect, useState } from 'react'
import { TwilioForwardingSection } from './TwilioForwardingSection'

const ENV_KEYS = [
  { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', placeholder: 'AC…', secret: false },
  { key: 'TWILIO_AUTH_TOKEN', label: 'Auth token', placeholder: '••••••••', secret: true },
] as const

const REGIONS = [
  { value: 'us1', label: 'United States' },
  { value: 'ie1', label: 'Ireland' },
  { value: 'au1', label: 'Australia' },
] as const

type Status =
  | { configured: false; region: string }
  | { configured: true; connected: true; accountName: string; fromNumber: string; region: string }
  | { configured: true; connected: false; error?: string; region: string }

type AccountNumber = {
  sid: string
  phoneNumber: string
  friendlyName: string
  smsCapable: boolean
  onSite: boolean
  isDefaultSms: boolean
}

export function TwilioSettingsTab() {
  const [setVars, setSetVars] = useState<Record<string, boolean>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [localMode, setLocalMode] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [numbers, setNumbers] = useState<AccountNumber[] | null>(null)
  const [numbersError, setNumbersError] = useState('')
  const [busySid, setBusySid] = useState('')
  const [region, setRegion] = useState('us1')
  const [regionSaving, setRegionSaving] = useState(false)
  const [regionSaved, setRegionSaved] = useState(false)
  const [regionError, setRegionError] = useState('')

  async function load() {
    try {
      const [envRes, statusRes] = await Promise.all([
        fetch('/api/admin/env'),
        fetch('/api/m/twilio/admin/status'),
      ])
      if (envRes.ok) {
        const d = await envRes.json()
        setSetVars(d.vars ?? {})
        setLocalMode(!!d.localMode)
      }
      if (statusRes.ok) {
        const s = await statusRes.json()
        setStatus(s)
        setRegion(s.region)
      }
    } catch {
      // Status stays null; the tab still renders the input fields.
    }
  }

  useEffect(() => {
    Promise.all([fetch('/api/admin/env'), fetch('/api/m/twilio/admin/status')])
      .then(async ([envRes, statusRes]) => {
        if (envRes.ok) {
          const d = await envRes.json()
          setSetVars(d.vars ?? {})
          setLocalMode(!!d.localMode)
        }
        if (statusRes.ok) {
          const s = await statusRes.json()
          setStatus(s)
          setRegion(s.region)
        }
      })
      .catch(() => {})
  }, [])

  const connected = status?.configured === true && status.connected

  async function handleSaveRegion() {
    setRegionSaving(true)
    setRegionSaved(false)
    setRegionError('')
    try {
      const res = await fetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars: [{ key: 'TWILIO_REGION', value: region }] }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      setRegionSaved(true)
      await load()
    } catch (err: unknown) {
      setRegionError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setRegionSaving(false)
    }
  }

  useEffect(() => {
    if (!connected) return
    fetch('/api/m/twilio/admin/site-numbers')
      .then(async (res) => {
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'Failed to load numbers')
        setNumbers(d.numbers)
        setNumbersError('')
      })
      .catch((err: unknown) => setNumbersError(err instanceof Error ? err.message : 'Failed to load numbers'))
  }, [connected])

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const vars = ENV_KEYS
        .map(({ key }) => ({ key, value: values[key] ?? '' }))
        .filter((v) => v.value.trim() !== '')
      const res = await fetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      setSaved(true)
      setValues({})
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function updateNumber(sid: string, action: 'add' | 'remove' | 'set-default-sms') {
    setBusySid(sid)
    setNumbersError('')
    try {
      const res = await fetch('/api/m/twilio/admin/site-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sid }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to update numbers')
      setNumbers(d.numbers)
      // The "sending texts from" line in the status alert tracks the default.
      const statusRes = await fetch('/api/m/twilio/admin/status')
      if (statusRes.ok) setStatus(await statusRes.json())
    } catch (err: unknown) {
      setNumbersError(err instanceof Error ? err.message : 'Failed to update numbers')
    } finally {
      setBusySid('')
    }
  }

  const hasInput = ENV_KEYS.some(({ key }) => (values[key] ?? '').trim() !== '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="card">
        <h2 className="card-title">Twilio</h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
          Connect your Twilio account to manage call forwarding and send sign-in codes by text
          message. Find your Account SID and Auth token on the Twilio console dashboard.
        </p>

        {error && <div className="alert alert-danger">{error}</div>}
        {saved && (
          <div className="alert alert-success">
            Saved. Changes take effect after the next deployment.
          </div>
        )}

        {status && (
          status.configured === false ? (
            <div className="alert alert-warning">Not configured yet - add both values below.</div>
          ) : status.connected ? (
            status.fromNumber ? (
              <div className="alert alert-success">
                Connected to <strong>{status.accountName}</strong>, sending texts from <strong>{status.fromNumber}</strong>.
              </div>
            ) : (
              <div className="alert alert-warning">
                Connected to <strong>{status.accountName}</strong>. Add a text-enabled phone
                number below to send sign-in codes.
              </div>
            )
          ) : (
            <div className="alert alert-danger">
              Credentials are set but Twilio rejected them{status.error ? `: ${status.error}` : ''}.
            </div>
          )
        )}

        {localMode ? (
          <div className="alert alert-warning">
            Local development mode: set these in <code>.env.local</code> and restart the dev server.
          </div>
        ) : (
          <>
            {ENV_KEYS.map(({ key, label, placeholder, secret }) => (
              <div className="field" key={key}>
                <label>
                  {label}
                  {setVars[key] && (
                    <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-success, var(--color-text-muted))' }}>
                      (set)
                    </span>
                  )}
                </label>
                <input
                  type={secret ? 'password' : 'text'}
                  value={values[key] ?? ''}
                  placeholder={setVars[key] ? 'Leave blank to keep current value' : placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  autoComplete="off"
                />
              </div>
            ))}
            <button className="btn btn-primary" disabled={!hasInput || saving} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}

        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label>Routing country</label>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
            Where Twilio processes and stores calls, texts and recordings for this site.
          </p>
          {regionError && <div className="alert alert-danger">{regionError}</div>}
          {regionSaved && <div className="alert alert-success">Saved. Changes take effect after the next deployment.</div>}
          {localMode ? (
            <div className="alert alert-warning">
              Local development mode: set <code>TWILIO_REGION</code> (us1, ie1 or au1) in{' '}
              <code>.env.local</code> and restart the dev server.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
              <select value={region} onChange={(e) => setRegion(e.target.value)}>
                {REGIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <button
                className="btn btn-primary"
                disabled={regionSaving || (status?.region ?? 'us1') === region}
                onClick={handleSaveRegion}
              >
                {regionSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>
      </div>

      {connected && (
        <div className="card">
          <h2 className="card-title">Phone numbers</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
            These are the numbers on your Twilio account. Add the ones you want this site to
            use, then choose which one sign-in codes are texted from. Only numbers that can
            send texts are offered for texting.
          </p>

          {numbersError && <div className="alert alert-danger">{numbersError}</div>}

          {numbers === null ? (
            <p style={{ color: 'var(--color-text-muted)' }}>Loading numbers…</p>
          ) : numbers.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)' }}>
              No phone numbers found on this Twilio account. Buy one in the Twilio console
              first, then come back here.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {numbers.map((n) => (
                <div
                  key={n.sid}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 'var(--space-4)',
                    padding: 'var(--space-3) var(--space-4)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <div style={{ minWidth: '12rem', flex: '1 1 12rem' }}>
                    <div style={{ fontWeight: 'var(--font-semibold)', color: 'var(--color-text)' }}>{n.phoneNumber}</div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{n.friendlyName}</div>
                  </div>
                  <span
                    style={{
                      fontSize: 'var(--text-xs)',
                      color: 'var(--color-text-muted)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0 var(--space-2)',
                    }}
                  >
                    {n.smsCapable ? 'Texts' : 'No texts'}
                  </span>
                  {n.onSite && n.smsCapable && (
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        cursor: busySid ? 'default' : 'pointer',
                        color: 'var(--color-text)',
                        fontSize: 'var(--text-sm)',
                        margin: 0,
                      }}
                    >
                      <input
                        type="radio"
                        name="twilio-default-sms"
                        checked={n.isDefaultSms}
                        disabled={!!busySid}
                        onChange={() => updateNumber(n.sid, 'set-default-sms')}
                      />
                      Send texts from this number
                    </label>
                  )}
                  <button
                    className={n.onSite ? 'btn btn-secondary' : 'btn btn-primary'}
                    style={{ marginLeft: 'auto' }}
                    disabled={busySid === n.sid}
                    onClick={() => updateNumber(n.sid, n.onSite ? 'remove' : 'add')}
                  >
                    {busySid === n.sid ? 'Working…' : n.onSite ? 'Remove from site' : 'Add to site'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {connected && <TwilioForwardingSection />}
    </div>
  )
}
