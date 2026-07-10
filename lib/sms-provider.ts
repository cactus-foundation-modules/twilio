// SMS provider contributed to core auth via the manifest's `smsProviders`
// field. Core delivers login codes through this when the module is active
// and configured - see lib/auth/sms.ts in core for the interface.
import { isTwilioConfigured, sendSms } from './twilio'

export const twilioSmsProvider = {
  id: 'twilio',
  label: 'Twilio SMS',
  isConfigured: () => isTwilioConfigured(),
  sendSms,
}
