'use client'

// Member account section (members.account-section extension point): lets a
// signed-in member enrol their phone for SMS sign-in codes. The whole card
// disappears when the site has no text-capable Twilio number set up - offering
// a sign-in method the site cannot deliver is worse than not mentioning it.
import SmsTwoFactorCard from '@/modules/twilio/components/SmsTwoFactorCard'

export function TwilioMemberSmsSection() {
  return (
    <SmsTwoFactorCard
      endpoint="/api/m/twilio/member/sms-2fa"
      title="Text message sign-in codes"
      description="Get your two-step sign-in codes by text message. When this is on, codes come to your phone instead of your email."
      hideWhenUnavailable
    />
  )
}
