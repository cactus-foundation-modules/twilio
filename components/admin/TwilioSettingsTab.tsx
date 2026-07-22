'use client'

// "Twilio" tab on the core admin settings page (settingsTabs manifest entry),
// split into sub-tabs the way the shop settings tab is:
//
//   Account       - credentials, country, connection status, live test button
//   Phone numbers - which account numbers the site uses, default texting number
//   Call handling - forwarding/greeting/voicemail/hours per number (own file)
//   Texting       - default sender summary and a send-a-test-text check
//   Alerts & data - email alerts for voicemails/missed calls, recording retention
//
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
import { TabStrip } from '@/components/admin/TabStrip'
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

const SUB_TABS = [
  { key: 'account', label: 'Account' },
  { key: 'numbers', label: 'Phone numbers' },
  { key: 'calls', label: 'Call handling' },
  { key: 'texting', label: 'Texting' },
  { key: 'alerts', label: 'Alerts & data' },
] as const

type SubTab = (typeof SUB_TABS)[number]['key']

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
  routesError: string | null
}

type TestResult = { region: string; ok: boolean; accountName?: string; error?: string }

type TwilioSettings = {
  notifyVoicemailEmail: boolean
  notifyMissedCallEmail: boolean
  notifyEmail: string
  retentionDays: number
}

const mutedText: React.CSSProperties = {
  color: 'var(--color-text-muted)',
  fontSize: 'var(--text-sm)',
  margin: '0 0 var(--space-3)',
}

export function TwilioSettingsTab() {
  const [subTab, setSubTab] = useState<SubTab>('account')
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
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState<TestResult[] | null>(null)
  const [testError, setTestError] = useState('')

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

  // Live credential check against Twilio, using whatever is typed and falling
  // back to the saved values - so a typo is caught before the save-and-redeploy
  // round trip rather than after it.
  async function handleTestConnection() {
    const problem = credentialProblem()
    if (problem) {
      setTestResults(null)
      setTestError(problem)
      return
    }
    setTesting(true)
    setTestError('')
    setTestResults(null)
    try {
      const tokens: Record<string, string> = {}
      for (const key of envKeys) {
        if (key === ACCOUNT_SID_KEY.key) continue
        const typed = (values[key] ?? '').trim()
        if (typed !== '') tokens[key] = typed
      }
      const res = await fetch('/api/m/twilio/admin/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          homeRegion,
          accountSid: (values[ACCOUNT_SID_KEY.key] ?? '').trim(),
          tokens,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Test failed')
      setTestResults(d.regions)
    } catch (err: unknown) {
      setTestError(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setTesting(false)
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

  const setupSteps = (
    <>
      <p style={mutedText}>
        Connect your Twilio account to manage call forwarding and send sign-in codes by text
        message. Setting up takes two values from the Twilio console:
      </p>
      <ol style={{ ...mutedText, paddingLeft: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <li>
          <strong>Pick your account&apos;s country</strong> below first. It&apos;s the country
          shown in the region switcher at the top of the Twilio console - not where you are,
          and not where your phone numbers are.
        </li>
        <li>
          In the Twilio console, open <strong>Account &rarr; API keys &amp; tokens</strong>.
          Copy the <strong>Account SID</strong> from the top of the page (it starts with AC and
          is the same everywhere) and paste it below.
        </li>
        <li>
          On that same page, under <strong>Auth tokens</strong>, copy the{' '}
          <strong>Primary auth token</strong> and paste it below. Check the page&apos;s region
          dropdown shows the same country as step 1 - each country issues its own token, and
          they don&apos;t work anywhere else.
        </li>
        <li>
          <strong>Save.</strong> The details take effect after the next deployment, then your
          phone numbers appear on the Phone numbers tab.
        </li>
      </ol>
      <p style={{ ...mutedText, margin: '0 0 var(--space-4)' }}>
        Mind the lookalikes: API keys (starting SK) are a different thing and won&apos;t work
        here - it&apos;s the Account SID and auth token or nothing.
      </p>
    </>
  )

  const connectFirst = (
    <div className="alert alert-warning">
      Connect your Twilio account on the Account tab first.
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <TabStrip
        items={SUB_TABS.map((t) => ({
          key: t.key,
          label: t.label,
          active: t.key === subTab,
          onClick: () => setSubTab(t.key),
        }))}
      />

      {subTab === 'account' && (
        <div className="card">
          <h2 className="card-title">Twilio account</h2>

          {/* The full walk-through matters exactly once; after that it's
              furniture. Connected installs get it folded away but reachable. */}
          {connected ? (
            <details style={{ marginBottom: 'var(--space-4)' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                How the set-up works
              </summary>
              <div style={{ marginTop: 'var(--space-3)' }}>{setupSteps}</div>
            </details>
          ) : (
            setupSteps
          )}

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
                  number on the Phone numbers tab to send sign-in codes.
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

              {homeRegion === 'us1' && (
                <>
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
                  <p style={mutedText}>
                    Only needed if you route a number to another country (set per number on the
                    Phone numbers tab). Twilio issues a <strong>separate</strong> token for each
                    country - your main token won&apos;t work there. Find them in the Twilio console
                    under API keys &amp; tokens, with the country picked in the Region dropdown.
                    Leave blank if you don&apos;t use them.
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
                </>
              )}

              {testError && <div className="alert alert-danger">{testError}</div>}
              {testResults?.map((r) =>
                r.ok ? (
                  <div className="alert alert-success" key={r.region}>
                    {REGION_LABELS[r.region] ?? r.region}: connected to <strong>{r.accountName}</strong>.
                  </div>
                ) : (
                  <div className="alert alert-danger" key={r.region}>
                    {REGION_LABELS[r.region] ?? r.region}: {r.error ?? 'connection failed'}
                  </div>
                )
              )}

              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" disabled={!hasInput || saving} onClick={handleSave}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-secondary" disabled={testing} onClick={handleTestConnection}>
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
              </div>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', margin: 'var(--space-2) 0 0' }}>
                Test connection checks what you&apos;ve typed against Twilio right now, before
                anything is saved - blank fields fall back to the saved values.
              </p>
            </>
          )}
        </div>
      )}

      {subTab === 'numbers' && (
        !connected ? connectFirst : (
          <div className="card">
            <h2 className="card-title">Phone numbers</h2>
            <p style={{ ...mutedText, margin: '0 0 var(--space-4)' }}>
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
                    {n.onSite && homeRegion === 'us1' && (
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
                    {n.routesError && (
                      <div
                        className="alert alert-warning"
                        style={{ flexBasis: '100%', margin: 0 }}
                      >
                        Couldn&apos;t read this number&apos;s live routing from Twilio, so the country
                        shown is the last one saved here: {n.routesError}
                      </div>
                    )}
                    {n.regionTokenMissing && n.region && (
                      <div
                        className="alert alert-warning"
                        style={{ flexBasis: '100%', margin: 0 }}
                      >
                        This number runs through <strong>{REGION_LABELS[n.region] ?? n.region}</strong>,
                        but there&apos;s no {REGION_LABELS[n.region] ?? n.region} token set - so its calls
                        and texts won&apos;t show up. Add one on the Account tab.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {homeRegion === 'us1' ? (
              <p style={{ ...mutedText, margin: 'var(--space-4) 0 0' }}>
                <strong>Country</strong> is where Twilio handles and stores that number&apos;s calls,
                texts and recordings. Changing it takes up to five minutes to bed in at Twilio&apos;s end,
                and only affects what happens from then on - anything already logged stays in the
                country it happened in.
              </p>
            ) : (
              <p style={{ ...mutedText, margin: 'var(--space-4) 0 0' }}>
                Your Twilio account lives in <strong>{REGION_LABELS[homeRegion] ?? homeRegion}</strong>,
                so all of its numbers are handled and stored there - no per-number country choice
                needed (Twilio only offers that to United States accounts).
              </p>
            )}
          </div>
        )
      )}

      {subTab === 'calls' && (!connected ? connectFirst : <TwilioForwardingSection />)}

      {subTab === 'texting' && (!connected ? connectFirst : <TextingCard status={status} />)}

      {subTab === 'alerts' && (!connected ? connectFirst : <AlertsCard />)}
    </div>
  )
}

// Texting tab: where texts come from, and a live "does it actually send"
// check that goes to the admin's own phone rather than through a sign-in flow.
function TextingCard({ status }: { status: Status | null }) {
  const [testTo, setTestTo] = useState('')
  const [sending, setSending] = useState(false)
  const [sentFrom, setSentFrom] = useState('')
  const [error, setError] = useState('')

  const fromNumber = status?.configured === true && status.connected ? status.fromNumber : ''

  async function sendTest() {
    setSending(true)
    setError('')
    setSentFrom('')
    try {
      const res = await fetch('/api/m/twilio/admin/test-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to send the test text')
      setSentFrom(d.from)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send the test text')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="card">
      <h2 className="card-title">Texting</h2>
      {fromNumber ? (
        <p style={mutedText}>
          Texts - sign-in codes and missed-call replies - go out from{' '}
          <strong>{fromNumber}</strong>. Change which number that is on the Phone numbers tab.
        </p>
      ) : (
        <div className="alert alert-warning">
          No text-enabled number is set up yet. Add one on the Phone numbers tab and texts
          (sign-in codes included) can start going out.
        </div>
      )}

      <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--color-text)', margin: 'var(--space-4) 0 var(--space-1)' }}>
        Send a test text
      </h3>
      <p style={mutedText}>
        Proves the whole sending path - credentials, number, country - without touching
        sign-in codes. The message says it&apos;s a test.
      </p>

      {error && <div className="alert alert-danger">{error}</div>}
      {sentFrom && (
        <div className="alert alert-success">
          Sent from <strong>{sentFrom}</strong> - it should land in a few seconds.
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-3)' }}>
        <div className="field" style={{ margin: 0, flex: '0 1 16rem' }}>
          <label htmlFor="twilio-test-sms-to">Your mobile number</label>
          <input
            id="twilio-test-sms-to"
            type="tel"
            value={testTo}
            placeholder="+447700900123"
            onChange={(e) => setTestTo(e.target.value)}
          />
        </div>
        <button
          className="btn btn-secondary"
          disabled={sending || !testTo.trim() || !fromNumber}
          onClick={sendTest}
        >
          {sending ? 'Sending…' : 'Send test text'}
        </button>
      </div>
    </div>
  )
}

// Alerts & data tab: the tw_settings singleton - email alerts and recording
// retention. Saved through this module's own settings route, so it takes
// effect immediately (no redeploy, unlike the credentials).
function AlertsCard() {
  const [settings, setSettings] = useState<TwilioSettings | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/m/twilio/admin/settings')
      .then(async (res) => {
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'Failed to load settings')
        setSettings(d)
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load settings'))
  }, [])

  function set<K extends keyof TwilioSettings>(key: K, value: TwilioSettings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s))
    setSaved(false)
  }

  async function save() {
    if (!settings) return
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const res = await fetch('/api/m/twilio/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      setSettings(d)
      setSaved(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const checkboxRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    cursor: 'pointer',
    color: 'var(--color-text)',
    marginBottom: 'var(--space-3)',
  }

  return (
    <div className="card">
      <h2 className="card-title">Alerts &amp; data</h2>

      {loadError && <div className="alert alert-danger">{loadError}</div>}

      {!settings ? (
        !loadError && <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      ) : (
        <>
          <p style={mutedText}>
            Email alerts land the moment something happens on your numbers - no need to keep an
            eye on the call log. These changes apply straight away, no deployment needed.
          </p>

          {error && <div className="alert alert-danger">{error}</div>}
          {saved && <div className="alert alert-success">Saved.</div>}

          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={settings.notifyVoicemailEmail}
              onChange={(e) => set('notifyVoicemailEmail', e.target.checked)}
            />
            Email me when someone leaves a voicemail
          </label>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={settings.notifyMissedCallEmail}
              onChange={(e) => set('notifyMissedCallEmail', e.target.checked)}
            />
            Email me when a call goes unanswered
          </label>

          <div className="field" style={{ maxWidth: '24rem' }}>
            <label htmlFor="twilio-notify-email">Send alerts to</label>
            <input
              id="twilio-notify-email"
              type="email"
              value={settings.notifyEmail}
              placeholder="you@example.com"
              onChange={(e) => set('notifyEmail', e.target.value)}
            />
          </div>

          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--color-text)', margin: 'var(--space-5) 0 var(--space-1)' }}>
            Keeping recordings
          </h3>
          <p style={mutedText}>
            Call recordings and voicemails sit in your Twilio account until something deletes
            them. Set a keep-for period and anything older is cleared out automatically each
            night - deleted recordings are gone for good, so pick a period you can live with.
          </p>

          <div className="field" style={{ maxWidth: '16rem' }}>
            <label htmlFor="twilio-retention-days">Keep recordings for (days)</label>
            <input
              id="twilio-retention-days"
              type="number"
              min={0}
              max={3650}
              value={settings.retentionDays}
              onChange={(e) => set('retentionDays', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', margin: 'var(--space-1) 0 0' }}>
              0 keeps everything forever - the way it&apos;s always worked.
            </p>
          </div>

          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    </div>
  )
}
