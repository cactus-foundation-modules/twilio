'use client'

// "Twilio" tab on the core admin settings page (settingsTabs manifest entry).
// Credentials are stored as environment variables through the core-managed
// /api/admin/env route (declared via this module's requiredEnvVars). Phone
// numbers are picked from the connected account rather than typed in - texts
// only ever go out from a text-capable number the admin has added to the site.
//
// Regions: each number is routed to a country of its own, and each country
// needs its own auth token because a Twilio token only works in the region it
// was made in. So the credentials card carries one token field per country,
// and the routing choice sits per number down in Phone numbers.
import { useEffect, useState } from 'react'
import { TwilioForwardingSection } from './TwilioForwardingSection'

const ACCOUNT_SID_KEY = { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', placeholder: 'AC…' } as const
const MAIN_TOKEN_KEY = 'TWILIO_AUTH_TOKEN'
const HOME_REGION_KEY = 'TWILIO_HOME_REGION'

const REGION_LABELS: Record<string, string> = {
  us1: 'United States',
  ie1: 'Ireland',
  au1: 'Australia',
}

const REGION_OPTIONS = ['us1', 'ie1', 'au1'] as const

// The env var holding a region's auth token: the account's home region uses the
// main TWILIO_AUTH_TOKEN field, every other region routed to gets its own. Keep
// this in step with regionTokenEnvVar in lib/twilio.ts.
function regionTokenKey(region: string, homeRegion: string): string {
  return region === homeRegion ? MAIN_TOKEN_KEY : `TWILIO_AUTH_TOKEN_${region.toUpperCase()}`
}

type RegionStatus = {
  region: string
  configured: boolean
  connected: boolean
  error?: string
}

type Status =
  | { configured: false; homeRegion: string; regions: RegionStatus[] }
  | { configured: true; connected: true; homeRegion: string; accountName: string; fromNumber: string; configuredRegions: string[]; regions: RegionStatus[] }
  | { configured: true; connected: false; homeRegion: string; error?: string; regions: RegionStatus[] }

type AccountNumber = {
  sid: string
  phoneNumber: string
  friendlyName: string
  smsCapable: boolean
  onSite: boolean
  isDefaultSms: boolean
  region: string | null
  regionTokenMissing: boolean
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
      if (statusRes.ok) setStatus(await statusRes.json())
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
        if (statusRes.ok) setStatus(await statusRes.json())
      })
      .catch(() => {})
  }, [])

  const connected = status?.configured === true && status.connected

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

  // The Twilio account's home region - its control plane. The server reports the
  // saved value; the picker below can change it before the admin saves.
  const homeRegion =
    values[HOME_REGION_KEY] ?? (status && 'homeRegion' in status ? status.homeRegion : 'us1')

  // Every credential env var in play for the chosen home region: the Account SID,
  // the main (home) auth token, and a token per OTHER region routed to.
  const envKeys = [
    ACCOUNT_SID_KEY.key,
    MAIN_TOKEN_KEY,
    ...REGION_OPTIONS.filter((r) => r !== homeRegion).map((r) => regionTokenKey(r, homeRegion)),
  ]

  // Catch the classic credential mix-ups before they're saved and Twilio starts
  // returning riddles: an API key SID (SK…) where the Account SID (AC…) belongs,
  // or an SK… value pasted into an auth-token field.
  function credentialProblem(): string | null {
    const sid = (values[ACCOUNT_SID_KEY.key] ?? '').trim()
    if (sid !== '' && !/^AC[0-9a-fA-F]{32}$/.test(sid)) {
      return /^SK/i.test(sid)
        ? 'That Account SID is an API key SID (starts with SK). This module needs the Account SID, which starts with AC - it is at the top of the "API keys & tokens" page in the Twilio console, and is the same in every region.'
        : 'The Account SID should start with AC followed by 32 characters - it is at the top of the "API keys & tokens" page in the Twilio console.'
    }
    for (const key of envKeys) {
      if (key === ACCOUNT_SID_KEY.key) continue
      const value = (values[key] ?? '').trim()
      if (/^SK/i.test(value)) {
        return 'One of the auth-token fields holds an API key SID (starts with SK). Auth tokens are found under "Auth tokens" on the "API keys & tokens" page, with the right region picked - API keys will not work here.'
      }
    }
    return null
  }

  async function handleSave() {
    const problem = credentialProblem()
    if (problem) {
      setSaved(false)
      setError(problem)
      return
    }
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const vars = [HOME_REGION_KEY, ...envKeys]
        .map((key) => ({ key, value: values[key] ?? '' }))
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

  async function updateNumber(
    sid: string,
    action: 'add' | 'remove' | 'set-default-sms' | 'set-region',
    region?: string
  ) {
    setBusySid(sid)
    setNumbersError('')
    try {
      const res = await fetch('/api/m/twilio/admin/site-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sid, region }),
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

  const hasInput = [HOME_REGION_KEY, ...envKeys].some((key) => (values[key] ?? '').trim() !== '')

  // A non-home region whose token is set but rejected is worth shouting about:
  // the numbers routed there will show empty logs and no obvious reason why.
  // The home region's own failure is covered by the main "rejected" alert.
  const brokenRegions = (status?.regions ?? []).filter((r) => r.configured && !r.connected && r.region !== homeRegion)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="card">
        <h2 className="card-title">Twilio</h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
          Connect your Twilio account to manage call forwarding and send sign-in codes by text
          message. Everything you need is on the <strong>API keys &amp; tokens</strong> page of
          the Twilio console: the Account SID (starts with AC, same in every region) at the top,
          and a <strong>Primary auth token</strong> per region under Auth tokens. API keys
          (SIDs starting with SK) won&apos;t work here.
        </p>

        {error && <div className="alert alert-danger">{error}</div>}
        {saved && (
          <div className="alert alert-success">
            Saved. Changes take effect after the next deployment.
          </div>
        )}

        {status && (
          status.configured === false ? (
            <div className="alert alert-warning">Not configured yet - pick your country and add the values below.</div>
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

        {brokenRegions.map((r) => (
          <div className="alert alert-danger" key={r.region}>
            Your <strong>{REGION_LABELS[r.region] ?? r.region}</strong> token was rejected
            {r.error ? `: ${r.error}` : ''}. Numbers routed there won&apos;t show any calls or texts
            until it&apos;s right.
          </div>
        ))}

        {localMode ? (
          <div className="alert alert-warning">
            Local development mode: set these in <code>.env.local</code> and restart the dev server.
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="twilio-home-region">Twilio account country</label>
              <select
                id="twilio-home-region"
                value={homeRegion}
                onChange={(e) => setValues((v) => ({ ...v, [HOME_REGION_KEY]: e.target.value }))}
              >
                {REGION_OPTIONS.map((r) => (
                  <option key={r} value={r}>{REGION_LABELS[r]}</option>
                ))}
              </select>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', margin: 'var(--space-1) 0 0' }}>
                The country your Twilio account itself lives in - shown on the auth-token page of
                the Twilio console. The Account SID and main auth token below must be the ones for
                this country, or Twilio rejects them with an &ldquo;Authenticate&rdquo; error.
              </p>
            </div>

            <div className="field">
              <label>
                {ACCOUNT_SID_KEY.label}
                {setVars[ACCOUNT_SID_KEY.key] && (
                  <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-success, var(--color-text-muted))' }}>
                    (set)
                  </span>
                )}
              </label>
              <input
                type="text"
                value={values[ACCOUNT_SID_KEY.key] ?? ''}
                placeholder={setVars[ACCOUNT_SID_KEY.key] ? 'Leave blank to keep current value' : ACCOUNT_SID_KEY.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [ACCOUNT_SID_KEY.key]: e.target.value }))}
                autoComplete="off"
              />
            </div>

            <div className="field">
              <label>
                {REGION_LABELS[homeRegion] ?? homeRegion} auth token
                {setVars[MAIN_TOKEN_KEY] && (
                  <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-success, var(--color-text-muted))' }}>
                    (set)
                  </span>
                )}
              </label>
              <input
                type="password"
                value={values[MAIN_TOKEN_KEY] ?? ''}
                placeholder={setVars[MAIN_TOKEN_KEY] ? 'Leave blank to keep current value' : '••••••••'}
                onChange={(e) => setValues((v) => ({ ...v, [MAIN_TOKEN_KEY]: e.target.value }))}
                autoComplete="off"
              />
            </div>

            <h3
              style={{
                fontSize: 'var(--text-sm)',
                fontWeight: 'var(--font-semibold)',
                color: 'var(--color-text)',
                margin: 'var(--space-5) 0 var(--space-1)',
              }}
            >
              Other countries
            </h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-3)' }}>
              Only needed if you route a number to another country (set per number below). Twilio
              issues a <strong>separate</strong> token for each country - your main token
              won&apos;t work there. Find them in the Twilio console under API keys &amp; tokens,
              with the country picked in the Region dropdown. Leave blank if you don&apos;t use them.
            </p>
            {REGION_OPTIONS.filter((r) => r !== homeRegion).map((r) => {
              const key = regionTokenKey(r, homeRegion)
              return (
                <div className="field" key={key}>
                  <label>
                    {REGION_LABELS[r] ?? r} auth token
                    {setVars[key] && (
                      <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-success, var(--color-text-muted))' }}>
                        (set)
                      </span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={values[key] ?? ''}
                    placeholder={setVars[key] ? 'Leave blank to keep current value' : '••••••••'}
                    onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    autoComplete="off"
                  />
                </div>
              )
            })}

            <button className="btn btn-primary" disabled={!hasInput || saving} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
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
                  {n.onSite && (
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        color: 'var(--color-text)',
                        fontSize: 'var(--text-sm)',
                        margin: 0,
                      }}
                    >
                      Country
                      <select
                        value={n.region ?? 'us1'}
                        disabled={!!busySid}
                        onChange={(e) => updateNumber(n.sid, 'set-region', e.target.value)}
                      >
                        {REGION_OPTIONS.map((r) => (
                          <option key={r} value={r}>{REGION_LABELS[r]}</option>
                        ))}
                      </select>
                    </label>
                  )}
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
                  {n.regionTokenMissing && n.region && (
                    <div
                      className="alert alert-warning"
                      style={{ flexBasis: '100%', margin: 0 }}
                    >
                      This number runs through <strong>{REGION_LABELS[n.region] ?? n.region}</strong>,
                      but there&apos;s no {REGION_LABELS[n.region] ?? n.region} token set - so its calls
                      and texts won&apos;t show up. Add one above.
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: 'var(--space-4) 0 0' }}>
            <strong>Country</strong> is where Twilio handles and stores that number&apos;s calls,
            texts and recordings. Changing it takes up to five minutes to bed in at Twilio&apos;s end,
            and only affects what happens from then on - anything already logged stays in the
            country it happened in.
          </p>
        </div>
      )}

      {connected && <TwilioForwardingSection />}
    </div>
  )
}
