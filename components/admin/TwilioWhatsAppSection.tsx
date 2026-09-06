'use client'

// "WhatsApp" sub-tab on the Twilio settings tab.
//
// Four cards, in the order somebody actually needs them: switch it on and say
// which number sends, register the templates Meta has approved, send one, and
// read what has been said. The 24-hour window is the thing this screen exists
// to make plain - WhatsApp will not carry an ordinary message to somebody who
// has not written in the last day, and a screen that let you type one anyway
// would be lying to the person pressing Send.
import { useEffect, useState } from 'react'

type SiteNumber = { phoneNumber: string; friendlyName: string; region: string }

type Config = {
  enabled: boolean
  sender: string
  region: string
  siteNumbers: SiteNumber[]
  sandboxSender: string
}

type Template = {
  id: string
  contentSid: string
  label: string
  variableCount: number
}

type Media = { sid: string; contentType: string }

type Message = {
  sid: string
  from: string
  to: string
  direction: 'inbound' | 'outbound'
  status: string
  dateSent: string
  body: string
  media: Media[]
}

type WindowState = { phoneNumber: string; lastInboundAt: string; open: boolean }

type Log = {
  ready: boolean
  sender: string | null
  messages: Message[]
  windows?: WindowState[]
}

const REGION_LABELS: Record<string, string> = {
  us1: 'United States',
  ie1: 'Ireland',
  au1: 'Australia',
}

const REGION_OPTIONS = ['us1', 'ie1', 'au1'] as const

const mutedText: React.CSSProperties = {
  color: 'var(--color-text-secondary)',
  fontSize: 'var(--text-sm)',
  margin: '0 0 var(--space-3)',
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--color-text-secondary)',
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

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The custom-number option in the sender picker. A value no phone number can
 *  take, so it cannot be confused with one. */
const OTHER = 'other'

// Reading is kept separate from storing all through this file: a fetch that
// returns its answer (or throws) can be called from an effect without setting
// any state synchronously, and each caller then decides what to do with it.

async function fetchTemplates(): Promise<Template[]> {
  const res = await fetch('/api/m/twilio/admin/whatsapp/templates')
  const d = await res.json()
  if (!res.ok) throw new Error(d.error ?? 'The templates could not be read')
  return d.templates ?? []
}

async function fetchLog(): Promise<Log> {
  const res = await fetch('/api/m/twilio/admin/whatsapp/messages')
  const d = await res.json()
  if (!res.ok) throw new Error(d.error ?? 'The messages could not be read')
  return d
}

export default function TwilioWhatsAppSection() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <SetupCard />
      <TemplatesCard />
      <SendCard />
      <LogCard />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Switching it on
// ---------------------------------------------------------------------------

function SetupCard() {
  const [config, setConfig] = useState<Config | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [sender, setSender] = useState('')
  const [region, setRegion] = useState('us1')
  const [choice, setChoice] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/m/twilio/admin/whatsapp/settings')
      .then(async (res) => {
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'Those settings could not be read')
        setConfig(d)
        setEnabled(d.enabled)
        setSender(d.sender)
        setRegion(d.region)
        // A saved sender that is one of the site's own numbers shows as that
        // number rather than dropping into the "another number" box, so the
        // screen reads back what was chosen rather than how it was stored.
        const known = (d.siteNumbers as SiteNumber[]).some((n) => n.phoneNumber === d.sender)
        setChoice(!d.sender ? '' : known || d.sender === d.sandboxSender ? d.sender : OTHER)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Those settings could not be read'))
  }, [])

  function pick(value: string) {
    setChoice(value)
    if (value !== OTHER) {
      setSender(value)
      // A site number's messages are processed where that number is routed, so
      // choosing one settles the country too - one fewer thing to get wrong.
      const match = config?.siteNumbers.find((n) => n.phoneNumber === value)
      if (match) setRegion(match.region)
    }
  }

  async function save() {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const res = await fetch('/api/m/twilio/admin/whatsapp/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, sender, region }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Those settings could not be saved')
      setSender(d.sender)
      setRegion(d.region)
      setSaved(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Those settings could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h2 className="card-title">WhatsApp</h2>
      <p style={mutedText}>
        Twilio carries WhatsApp on the same account as your calls and texts. Messages turn up in
        your inbox beside everything else, and you can answer them from there.
      </p>

      <details style={{ marginBottom: 'var(--space-4)' }}>
        <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
          What you need before this works
        </summary>
        <div style={{ ...mutedText, marginTop: 'var(--space-3)' }}>
          <p style={{ margin: '0 0 var(--space-2)' }}>
            To send from your own number, WhatsApp has to approve it first - that is done in the
            Twilio console under Messaging, and it takes a few days. Until then you can use
            Twilio&apos;s shared sandbox number, which works straight away as long as each person
            you want to message has sent Twilio the join code first.
          </p>
          <p style={{ margin: 0 }}>
            WhatsApp only carries an ordinary message for 24 hours after somebody last wrote to
            you. After that, only wording WhatsApp has approved in advance will go - see Templates
            below.
          </p>
        </div>
      </details>

      {error && <div className="alert alert-danger">{error}</div>}
      {saved && <div className="alert alert-success">Saved.</div>}

      <div className="field">
        <label htmlFor="twilio-wa-enabled" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            id="twilio-wa-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Use WhatsApp on this site
        </label>
      </div>

      <div className="field">
        <label htmlFor="twilio-wa-sender">Messages go out from</label>
        <select id="twilio-wa-sender" value={choice} onChange={(e) => pick(e.target.value)}>
          <option value="">Choose a number…</option>
          {config?.siteNumbers.map((n) => (
            <option key={n.phoneNumber} value={n.phoneNumber}>
              {n.phoneNumber}
              {n.friendlyName ? ` - ${n.friendlyName}` : ''}
            </option>
          ))}
          {config && (
            <option value={config.sandboxSender}>{config.sandboxSender} - Twilio&apos;s test number</option>
          )}
          <option value={OTHER}>Another number…</option>
        </select>
      </div>

      {choice === OTHER && (
        <div className="field">
          <label htmlFor="twilio-wa-sender-other">The number, in international format</label>
          <input
            id="twilio-wa-sender-other"
            type="tel"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            placeholder="+447700900123"
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="twilio-wa-region">Handled in</label>
        <select id="twilio-wa-region" value={region} onChange={(e) => setRegion(e.target.value)}>
          {REGION_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {REGION_LABELS[r] ?? r}
            </option>
          ))}
        </select>
        <p style={{ ...mutedText, margin: 'var(--space-1) 0 0' }}>
          The same country the number&apos;s calls and texts are handled in. Pick one of your own
          numbers above and this fills itself in.
        </p>
      </div>

      <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Approved wording
// ---------------------------------------------------------------------------

function TemplatesCard() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [label, setLabel] = useState('')
  const [contentSid, setContentSid] = useState('')
  const [variableCount, setVariableCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchTemplates()
      .then(setTemplates)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'The templates could not be read'),
      )
  }, [])

  async function add() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/m/twilio/admin/whatsapp/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, contentSid, variableCount }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'That template could not be saved')
      setTemplates(d.templates)
      setLabel('')
      setContentSid('')
      setVariableCount(0)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That template could not be saved')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/m/twilio/admin/whatsapp/templates?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'That template could not be removed')
      setTemplates(d.templates)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That template could not be removed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2 className="card-title">Approved templates</h2>
      <p style={mutedText}>
        Wording WhatsApp has approved in advance. It is the only thing that will reach somebody who
        has not written to you in the last 24 hours - a delivery update, an appointment reminder,
        that sort of thing. Write them in the Twilio console under Content Template Builder, then
        add each one here with the id Twilio gives it.
      </p>

      {error && <div className="alert alert-danger">{error}</div>}

      {templates.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 'var(--space-4)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Twilio id</th>
                <th style={thStyle}>Blanks</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td style={tdStyle}>{t.label}</td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                    {t.contentSid}
                  </td>
                  <td style={tdStyle}>{t.variableCount}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => remove(t.id)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-3)' }}>
        <div className="field" style={{ margin: 0, flex: '1 1 12rem' }}>
          <label htmlFor="twilio-wa-tpl-label">What you call it</label>
          <input
            id="twilio-wa-tpl-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Order dispatched"
          />
        </div>
        <div className="field" style={{ margin: 0, flex: '1 1 20rem' }}>
          <label htmlFor="twilio-wa-tpl-sid">Twilio id</label>
          <input
            id="twilio-wa-tpl-sid"
            type="text"
            value={contentSid}
            onChange={(e) => setContentSid(e.target.value)}
            placeholder="HX…"
          />
        </div>
        <div className="field" style={{ margin: 0, flex: '0 0 7rem' }}>
          <label htmlFor="twilio-wa-tpl-vars">Blanks</label>
          <input
            id="twilio-wa-tpl-vars"
            type="number"
            min={0}
            max={10}
            value={variableCount}
            onChange={(e) => setVariableCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={add}
          disabled={busy || !label.trim() || !contentSid.trim()}
        >
          Add
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sending one
// ---------------------------------------------------------------------------

function SendCard() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [to, setTo] = useState('')
  const [mode, setMode] = useState<'text' | 'template'>('text')
  const [text, setText] = useState('')
  const [contentSid, setContentSid] = useState('')
  const [variables, setVariables] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [sentFrom, setSentFrom] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    // A failure here leaves the template menu empty, which the card already
    // explains - there is nothing further to say about it in a second place.
    fetchTemplates().then(setTemplates).catch(() => {})
  }, [])

  const template = templates.find((t) => t.contentSid === contentSid) ?? null

  function pickTemplate(sid: string) {
    setContentSid(sid)
    const picked = templates.find((t) => t.contentSid === sid)
    setVariables(new Array(picked?.variableCount ?? 0).fill(''))
  }

  async function send() {
    setSending(true)
    setError('')
    setSentFrom('')
    try {
      const body =
        mode === 'template'
          ? { to, contentSid, variables }
          : { to, text }
      const res = await fetch('/api/m/twilio/admin/whatsapp/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'That message could not be sent')
      setSentFrom(d.from)
      setText('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That message could not be sent')
    } finally {
      setSending(false)
    }
  }

  const ready =
    !!to.trim() && (mode === 'text' ? !!text.trim() : !!contentSid && variables.every((v) => v.trim()))

  return (
    <div className="card">
      <h2 className="card-title">Send a message</h2>
      <p style={mutedText}>
        A plain message only reaches somebody who has written to you in the last 24 hours. Outside
        that, send one of your approved templates - this will tell you which of the two applies
        rather than letting a message quietly go nowhere.
      </p>

      {error && <div className="alert alert-danger">{error}</div>}
      {sentFrom && (
        <div className="alert alert-success">
          Sent from <strong>{sentFrom}</strong>.
        </div>
      )}

      <div className="field">
        <label htmlFor="twilio-wa-to">Their number</label>
        <input
          id="twilio-wa-to"
          type="tel"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="+447700900123"
        />
      </div>

      <div className="field">
        <label htmlFor="twilio-wa-mode">Send</label>
        <select
          id="twilio-wa-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value === 'template' ? 'template' : 'text')}
        >
          <option value="text">A message you write now</option>
          <option value="template">An approved template</option>
        </select>
      </div>

      {mode === 'text' ? (
        <div className="field">
          <label htmlFor="twilio-wa-text">Message</label>
          <textarea
            id="twilio-wa-text"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4096}
          />
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="twilio-wa-template">Template</label>
            <select id="twilio-wa-template" value={contentSid} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.contentSid}>
                  {t.label}
                </option>
              ))}
            </select>
            {templates.length === 0 && (
              <p style={{ ...mutedText, margin: 'var(--space-1) 0 0' }}>
                No templates added yet - add one above first.
              </p>
            )}
          </div>
          {template && variables.map((value, index) => (
            <div className="field" key={index}>
              <label htmlFor={`twilio-wa-var-${index}`}>Blank {index + 1}</label>
              <input
                id={`twilio-wa-var-${index}`}
                type="text"
                value={value}
                onChange={(e) => {
                  const next = [...variables]
                  next[index] = e.target.value
                  setVariables(next)
                }}
              />
            </div>
          ))}
        </>
      )}

      <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !ready}>
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// What has been said
// ---------------------------------------------------------------------------

function LogCard() {
  const [log, setLog] = useState<Log | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  function store(promise: Promise<Log>) {
    promise
      .then((d) => {
        setLog(d)
        setError('')
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'The messages could not be read'),
      )
      .finally(() => setLoading(false))
  }

  // Once, on the way in. `store` is deliberately not a dependency: it is
  // redeclared each render, and naming it would re-read the log every time
  // anything else on the card changed.
  useEffect(() => {
    store(fetchLog())
  }, [])

  function refresh() {
    setLoading(true)
    store(fetchLog())
  }

  const windows = new Map((log?.windows ?? []).map((w) => [w.phoneNumber, w]))

  return (
    <div className="card">
      <h2 className="card-title">Recent WhatsApp messages</h2>

      {error && <div className="alert alert-danger">{error}</div>}

      {!error && log && !log.ready && (
        <div className="alert alert-warning">
          WhatsApp is not switched on yet. Turn it on and choose a sending number above.
        </div>
      )}

      {log?.ready && (
        <>
          <p style={mutedText}>
            Everything to and from <strong>{log.sender}</strong>, newest first. Twilio keeps these,
            so how far back this goes is up to your Twilio account rather than to this site.
          </p>
          <button type="button" className="btn btn-secondary" onClick={refresh} disabled={loading}>
            {loading ? 'Reading…' : 'Refresh'}
          </button>
        </>
      )}

      {log?.ready && log.messages.length === 0 && !loading && (
        <p style={{ ...mutedText, marginTop: 'var(--space-4)' }}>Nothing yet.</p>
      )}

      {log?.ready && log.messages.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 'var(--space-4)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>When</th>
                <th style={thStyle}>Who</th>
                <th style={thStyle}>Message</th>
              </tr>
            </thead>
            <tbody>
              {log.messages.map((m) => {
                const party = m.direction === 'inbound' ? m.from : m.to
                const state = windows.get(party)
                return (
                  <tr key={m.sid}>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatDate(m.dateSent)}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      <div>{party}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                        {m.direction === 'inbound' ? 'They wrote' : 'You wrote'}
                        {m.direction === 'inbound' && state && !state.open ? ' · needs a template now' : ''}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      {m.body || <em style={{ color: 'var(--color-text-secondary)' }}>No words</em>}
                      {m.media.length > 0 && (
                        <div style={{ marginTop: 'var(--space-1)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                          {m.media.map((media, index) => (
                            <a
                              key={media.sid}
                              href={`/api/m/twilio/admin/whatsapp/media/${encodeURIComponent(m.sid)}/${encodeURIComponent(media.sid)}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: 'var(--text-xs)' }}
                            >
                              Attachment {index + 1}
                            </a>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
