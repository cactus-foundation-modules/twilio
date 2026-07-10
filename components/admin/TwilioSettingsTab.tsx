'use client'

// "Twilio" tab on the core admin settings page (settingsTabs manifest entry).
// Credentials are stored as environment variables through the core-managed
// /api/admin/env route (declared via this module's requiredEnvVars).
import { useCallback, useEffect, useState } from 'react'

const ENV_KEYS = [
  { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', placeholder: 'AC…', secret: false },
  { key: 'TWILIO_AUTH_TOKEN', label: 'Auth token', placeholder: '••••••••', secret: true },
  { key: 'TWILIO_PHONE_NUMBER', label: 'From number', placeholder: '+447700900123', secret: false },
] as const

type Status =
  | { configured: false }
  | { configured: true; connected: true; accountName: string; fromNumber: string }
  | { configured: true; connected: false; error?: string }

export function TwilioSettingsTab() {
  const [setVars, setSetVars] = useState<Record<string, boolean>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [localMode, setLocalMode] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
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
      if (statusRes.ok) setStatus(await statusRes.json())
    } catch {
      // Status stays null; the tab still renders the input fields.
    }
  }, [])

  useEffect(() => {
    Promise.all([fetch('/api/admin/env'), fetch('/api/m/twilio/admin/status')])
      .then(async ([envRes, statusRes]) => {
        if (envRes.ok) {
          const d = await envRes.json()
          setSetVars(d.vars ?? {})
          setLocalMode(!!d.localMode)
        }
        if (statusRes.ok) setStatus(await statusRes.json())
      })
      .catch(() => {})
  }, [])

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

  const hasInput = ENV_KEYS.some(({ key }) => (values[key] ?? '').trim() !== '')

  return (
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
          <div className="alert alert-warning">Not configured yet - add all three values below.</div>
        ) : status.connected ? (
          <div className="alert alert-success">
            Connected to <strong>{status.accountName}</strong>, sending texts from <strong>{status.fromNumber}</strong>.
          </div>
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
    </div>
  )
}
