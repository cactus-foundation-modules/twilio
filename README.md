# Cactus Twilio Module

Twilio integration module for [Cactus](https://github.com/usersaynoso/cactus-foundation).

Provides:

- **Settings tab** - a Twilio tab on Admin > Settings for the Account SID, Auth token and
  from-number (stored as environment variables through the core settings mechanism).
- **Call forwarding** - an admin page listing the Twilio numbers on your account, each with a
  forward-to number and an on/off switch. Enabled numbers point their voice webhook at this
  module, which answers with TwiML that dials your chosen number.
- **SMS login codes** - admins and members can verify a mobile number and receive their
  two-step sign-in codes by text message instead of email, delivered through the core SMS
  provider hook. If Twilio ever becomes unavailable, codes silently fall back to email.

## Installation

Install from the Cactus admin panel under Modules using this repository's URL, then add your
credentials on Admin > Settings > Twilio.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth token |
| `TWILIO_PHONE_NUMBER` | Number texts are sent from, in international format |

## License

MIT
