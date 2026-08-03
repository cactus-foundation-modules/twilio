import type { EmailTemplateDef } from '@/lib/email/registry'

// This module's two alerts, declared for core's single email editor
// (Settings > Emails). Core owns the wording, the on/off switch, the wrapper
// design and the sending; this file is only the defaults.
//
// Whether these go out at all is still the module's own decision - the Twilio
// settings have their own switches for the missed-call and voicemail alerts,
// and those are checked before core is asked to render anything.

export const twilioEmailTemplates: EmailTemplateDef[] = [
  {
    key: 'twilio.missed-call',
    label: 'Missed call (admin alert)',
    subject: 'Missed call on {{calledNumber}}',
    bodyHtml:
      '<p><strong>{{caller}}</strong> rang <strong>{{calledNumber}}</strong> and nobody was able to answer.</p><p><a href="{{adminUrl}}">Open the call log</a></p>',
    mergeTags: ['caller', 'calledNumber', 'adminUrl', 'siteName'],
    requiredTags: ['adminUrl'],
    transactional: false,
  },
  {
    key: 'twilio.voicemail',
    label: 'New voicemail (admin alert)',
    subject: 'New voicemail from {{caller}}',
    bodyHtml:
      '<p><strong>{{caller}}</strong> left a {{duration}} voicemail on <strong>{{calledNumber}}</strong>.</p><p><a href="{{adminUrl}}">Listen from the call log</a></p>',
    mergeTags: ['caller', 'calledNumber', 'duration', 'adminUrl', 'siteName'],
    requiredTags: ['adminUrl'],
    transactional: false,
  },
]
