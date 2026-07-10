'use client'

// Admin account section (admins.account-section extension point): lets a
// signed-in admin enrol their own phone for SMS sign-in codes. Self-service
// only - no twilio.manage permission needed.
import SmsTwoFactorCard from '@/modules/twilio/components/SmsTwoFactorCard'

export function TwilioAdminSmsSection() {
  return (
    <SmsTwoFactorCard
      endpoint="/api/m/twilio/admin/sms-2fa"
      title="SMS login codes"
      description="Get your sign-in codes by text message instead of email when logging in with your password."
    />
  )
}
