'use client'

// "Templates" sub-tab of the Twilio settings tab: the wording of every text
// message the site sends, the way Settings > Emails owns the wording of every
// email.
//
// The templates themselves are core's (lib/sms/registry.ts) and are declared by
// whichever module sends them - the shop's order updates, today. This module
// owns the screen rather than the data, because texting is where an owner comes
// looking for it, and because a site without Twilio has no business being shown
// a text message editor at all.
import { useCallback, useEffect, useMemo, useState } from 'react'

type Template = {
  key: string
  label: string
  mergeTags: string[]
  requiredTags: string[]
  transactional: boolean
  body: string
  defaultBody: string
  isActive: boolean
  isOverridden: boolean
  updatedAt: string | null
}

type Group = { groupLabel: string; source: string; templates: Template[] }

const mutedText: React.CSSProperties = {
  color: 'var(--color-text-secondary)',
  fontSize: 'var(--text-sm)',
  margin: '0 0 var(--space-3)',
}

export default function TwilioSmsTemplatesCard() {
  const [groups, setGroups] = useState<Group[]>([])
  const [smsAvailable, setSmsAvailable] = useState(true)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [testTo, setTestTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ text: string; chars: number; segments: number; unicode: boolean } | null>(null)

  // Bumping this refetches - same trick as the email editor, and for the same
  // reason: calling load() straight from an effect body sets state during render.
  const [reloadToken, setReloadToken] = useState(0)
  const load = useCallback(() => setReloadToken((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/sms/templates')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setGroups(d.groups ?? [])
        setSmsAvailable(d.smsAvailable ?? false)
      })
      .catch(() => { if (!cancelled) setError('Could not load the messages.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reloadToken])

  const allTemplates = useMemo(() => groups.flatMap((g) => g.templates), [groups])
  const active = allTemplates.find((t) => t.key === activeKey) ?? null

  function selectTemplate(key: string) {
    const t = allTemplates.find((x) => x.key === key)
    if (!t) return
    setActiveKey(key)
    setBody(t.body)
    setIsActive(t.isActive)
    setMessage('')
    setError('')
    setPreview(null)
  }

  async function save() {
    if (!activeKey) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const res = await fetch(`/api/admin/sms/templates/${encodeURIComponent(activeKey)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, isActive }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Could not save that.')
      setMessage('Saved.')
      load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save that.')
    } finally {
      setSaving(false)
    }
  }

  async function resetToDefault() {
    if (!activeKey || !active) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const res = await fetch(`/api/admin/sms/templates/${encodeURIComponent(activeKey)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Could not reset that.')
      setBody(active.defaultBody)
      setMessage('Wording put back to the original.')
      load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not reset that.')
    } finally {
      setSaving(false)
    }
  }

  async function showPreview() {
    if (!activeKey) return
    setError('')
    try {
      const res = await fetch('/api/admin/sms/templates/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: activeKey, body }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Could not build the preview.')
      setPreview({ text: d.text, chars: d.chars, segments: d.segments, unicode: d.unicode })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not build the preview.')
    }
  }

  async function testSend() {
    if (!activeKey) return
    setError('')
    setMessage('')
    setTesting(true)
    try {
      const res = await fetch('/api/admin/sms/templates/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: activeKey, body, to: testTo }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Could not send that.')
      setMessage(`Test text sent to ${d.to}.`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send that.')
    } finally {
      setTesting(false)
    }
  }

  if (loading) return <p style={mutedText}>Loading messages…</p>

  if (allTemplates.length === 0) {
    return (
      <div className="card">
        <h2 className="card-title">Templates</h2>
        <p style={mutedText}>
          Nothing on this site sends a text message yet. Modules that do - the shop&apos;s order
          updates, for one - add their messages here as soon as they&apos;re installed.
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <h2 className="card-title">Templates</h2>
      <p style={mutedText}>
        The wording of every text your site sends. Keep them short - each message is charged by
        the segment, and the counter below tells you how many you&apos;re paying for.
      </p>

      {!smsAvailable && (
        <div className="alert alert-warning">
          No text-enabled number is set up, so nothing here is going anywhere yet. Add one on the
          Phone numbers tab.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) 1fr', gap: 'var(--space-5)', alignItems: 'start' }}>
        <div>
          {groups.map((group) => (
            <div key={`${group.source}:${group.groupLabel}`} style={{ marginBottom: 'var(--space-4)' }}>
              <div
                style={{
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  marginBottom: 'var(--space-2)',
                }}
              >
                {group.groupLabel}
              </div>
              {group.templates.map((t) => (
                <button
                  key={t.key}
                  onClick={() => selectTemplate(t.key)}
                  className={`btn ${activeKey === t.key ? 'btn-secondary' : 'btn-ghost'}`}
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 'var(--space-1)' }}
                >
                  <span>{t.label}</span>
                  {t.isOverridden && <span className="badge badge-blue" style={{ marginLeft: 'var(--space-2)' }}>Edited</span>}
                  {!t.isActive && <span className="badge badge-gray" style={{ marginLeft: 'var(--space-2)' }}>Off</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div>
          {!active && <p style={mutedText}>Pick a message on the left to change it.</p>}

          {active && (
            <>
              {error && <div className="alert alert-danger">{error}</div>}
              {message && <div className="alert alert-success">{message}</div>}

              <div className="field">
                <label>Wording you can drop in</label>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {active.mergeTags.map((tag) => (
                    <code
                      key={tag}
                      style={{
                        background: 'var(--color-bg-subtle)',
                        padding: '2px 6px',
                        borderRadius: 'var(--radius)',
                        fontSize: 'var(--text-sm)',
                        border: active.requiredTags.includes(tag) ? '1px solid var(--color-border)' : undefined,
                      }}
                      title={active.requiredTags.includes(tag) ? 'This one has to stay in - the message is no use without it.' : undefined}
                    >
                      {'{{' + tag + '}}'}
                      {active.requiredTags.includes(tag) ? ' *' : ''}
                    </code>
                  ))}
                </div>
                {active.requiredTags.length > 0 && (
                  <p className="field-hint">Anything marked * has to stay in, or whoever gets the text is none the wiser.</p>
                )}
              </div>

              <div className="field">
                <label htmlFor="sms-template-body">Message</label>
                <textarea
                  id="sms-template-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--text-sm)' }}
                />
                <p className="field-hint">
                  Plain text only - no links to a design, no header, no footer. Whatever you type is
                  the whole message.
                </p>
              </div>

              {!active.transactional && (
                <div className="field">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                    <span>Send this text</span>
                  </label>
                  <p className="field-hint">
                    Untick and this one stops going out, whoever asked for texts. The rest carry on.
                  </p>
                </div>
              )}

              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
                <button className="btn btn-primary" disabled={saving} onClick={save}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-secondary" onClick={showPreview}>Preview</button>
                {active.isOverridden && (
                  <button className="btn btn-ghost" disabled={saving} onClick={resetToDefault}>
                    Put the original wording back
                  </button>
                )}
              </div>

              {preview && (
                <div style={{ marginBottom: 'var(--space-4)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 'var(--space-2)', color: 'var(--color-text)' }}>Preview</div>
                  <div
                    style={{
                      whiteSpace: 'pre-wrap',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius)',
                      background: 'var(--color-bg-subtle)',
                      color: 'var(--color-text)',
                      padding: 'var(--space-3)',
                      fontSize: 'var(--text-sm)',
                    }}
                  >
                    {preview.text}
                  </div>
                  <p className="field-hint">
                    {preview.chars} characters, {preview.segments} message{preview.segments === 1 ? '' : 's'} to send
                    {preview.unicode ? ' - something in there is outside the plain text set, which shortens every message to 70 characters.' : '.'}
                  </p>
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-3)' }}>
                <div className="field" style={{ margin: 0, flex: '0 1 16rem' }}>
                  <label htmlFor="sms-template-test-to">Send a test to</label>
                  <input
                    id="sms-template-test-to"
                    type="tel"
                    value={testTo}
                    placeholder="+447700900123"
                    onChange={(e) => setTestTo(e.target.value)}
                  />
                </div>
                <button className="btn btn-secondary" disabled={testing || !testTo.trim() || !smsAvailable} onClick={testSend}>
                  {testing ? 'Sending…' : 'Send test'}
                </button>
              </div>
              <p className="field-hint">Stand-in details, and the message says it&apos;s a test.</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
