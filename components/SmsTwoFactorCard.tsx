'use client'

// Shared enrol/disable card for SMS login codes. Used by the admin Twilio page
// (admin endpoint) and the member account section (member endpoint) - the two
// APIs share the same request/response shape.
import { useCallback, useEffect, useState } from 'react'

type Props = {
  endpoint: string
  title: string
  description: string
}

type State = {
  available: boolean
  enabled: boolean
  maskedPhone: string | null
}

export default function SmsTwoFactorCard({ endpoint, title, description }: Props) {
  const [state, setState] = useState<State | null>(null)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [awaitingCode, setAwaitingCode] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint)
      if (!res.ok) return
      setState(await res.json())
    } catch {
      // Leave the card in its loading state - nothing actionable to show.
    }
  }, [endpoint])

  useEffect(() => {
    fetch(endpoint)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => { if (d) setState(d) })
      .catch(() => {})
  }, [endpoint])

  async function handleSend() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', phone }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to send code')
      setAwaitingCode(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send code')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', code }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Verification failed')
      setAwaitingCode(false)
      setPhone('')
      setCode('')
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleDisable() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch(endpoint, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error((d as { error?: string }).error ?? 'Failed to turn off')
      }
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to turn off')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card">
      <h2 className="card-title">{title}</h2>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
        {description}
      </p>

      {error && <div className="alert alert-danger">{error}</div>}

      {!state ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      ) : !state.available ? (
        <div className="alert alert-warning">
          Twilio is not configured, so text message codes are unavailable right now.
        </div>
      ) : state.enabled ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--color-text)' }}>
            On — codes go to <strong>{state.maskedPhone}</strong>
          </span>
          <button className="btn btn-danger" disabled={loading} onClick={handleDisable}>
            {loading ? 'Turning off…' : 'Turn off'}
          </button>
        </div>
      ) : awaitingCode ? (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Enter the code we texted you</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              placeholder="000000"
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6 && !loading) handleVerify() }}
              autoFocus
            />
          </div>
          <button className="btn btn-primary" disabled={code.length !== 6 || loading} onClick={handleVerify}>
            {loading ? 'Checking…' : 'Confirm'}
          </button>
          <button className="btn btn-secondary" disabled={loading} onClick={() => { setAwaitingCode(false); setCode(''); setError('') }}>
            Back
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Mobile number</label>
            <input
              type="tel"
              value={phone}
              placeholder="+447700900123"
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && phone && !loading) handleSend() }}
            />
          </div>
          <button className="btn btn-primary" disabled={!phone || loading} onClick={handleSend}>
            {loading ? 'Sending…' : 'Text me a code'}
          </button>
        </div>
      )}
    </div>
  )
}
