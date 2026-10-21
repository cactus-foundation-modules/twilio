'use client'

// "Connect to the unified inbox": points every Twilio number's incoming-text and
// call-status webhooks at this site, so a text or a finished call reaches the
// inbox at once rather than at the next hourly check. Numbers are also
// connected when they are saved or added; this is for the ones that were set
// up before, and for checking nothing has drifted.
import { useState } from 'react'
import { InfoTip } from '@/components/admin/InfoTip'

type Result = {
  phoneNumber: string
  texts: 'connected' | 'already' | 'other' | null
  textsElsewhere?: string
  calls: 'connected' | 'already' | 'other'
  callsElsewhere?: string
  error?: string
}

function describe(r: Result): { text: string; warn: boolean } {
  if (r.error) return { text: r.error, warn: true }
  const bits: string[] = []
  let warn = false
  if (r.texts === 'connected') bits.push('texts connected')
  else if (r.texts === 'already') bits.push('texts already connected')
  else if (r.texts === 'other') {
    bits.push(`texts left alone - they go to ${r.textsElsewhere}`)
    warn = true
  }
  if (r.calls === 'connected') bits.push('calls connected')
  else if (r.calls === 'already') bits.push('calls already connected')
  else {
    bits.push(`calls left alone - status goes to ${r.callsElsewhere}`)
    warn = true
  }
  return { text: bits.join(', '), warn }
}

export function TwilioInboxHookupCard() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<Result[] | null>(null)

  async function run() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/m/twilio/admin/connect-inbox', { method: 'POST' })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to connect numbers')
      setResults(d.results)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect numbers')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 'var(--space-4)' }}>
      <h2 className="card-title">
        Unified inbox <InfoTip>Tells Twilio to let this site know the moment a text arrives or a call ends, so it shows in the unified inbox straight away instead of at the next hourly check. Numbers are connected automatically when you save or add them; press this for any set up earlier. A number whose texts or call status already go somewhere else is left alone and listed below, so nothing that relies on it stops working.</InfoTip>
      </h2>
      {error && <div className="alert alert-danger">{error}</div>}
      <button type="button" className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? 'Connecting…' : 'Connect numbers to the inbox'}
      </button>
      {results && (
        <ul style={{ marginTop: 'var(--space-4)', paddingLeft: 'var(--space-4)' }}>
          {results.map((r) => {
            const d = describe(r)
            return (
              <li key={r.phoneNumber} style={{ color: d.warn ? 'var(--color-warning, inherit)' : 'inherit' }}>
                <strong>{r.phoneNumber}</strong> - {d.text}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
