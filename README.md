# Cactus Twilio Module

Twilio integration module for [Cactus](https://github.com/usersaynoso/cactus-foundation).

Provides:

- **Settings tab** - a Twilio tab on Admin > Settings for the Account SID and Auth token
  (stored as environment variables through the core settings mechanism), plus a phone
  numbers section listing the numbers on the connected account. Add the ones the site
  should use and pick which text-capable number sign-in codes are sent from.
- **Call forwarding** - an admin page listing the Twilio numbers on your account, each with a
  forward-to number and an on/off switch. Enabled numbers point their voice webhook at this
  module, which answers with TwiML that dials your chosen number. Each number can also take
  a voicemail when nobody answers, and keep opening hours - outside them the phone never
  rings, and callers can hear a greeting of their own instead of the usual one.
- **SMS login codes** - admins and members can verify a mobile number and receive their
  two-step sign-in codes by text message instead of email, delivered through the core SMS
  provider hook. If Twilio ever becomes unavailable, codes silently fall back to email.

## Installation

Install from the Cactus admin panel under Modules using this repository's URL, then add your
credentials on Admin > Settings > Twilio.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TWILIO_HOME_REGION` | The region your Twilio account lives in - `us1` (default), `ie1` or `au1`. Must match the console's auth-token page, or credentials are rejected with an "Authenticate" error. |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (the same value in every region) |
| `TWILIO_AUTH_TOKEN` | Auth token for the home region |
| `TWILIO_AUTH_TOKEN_US1` | Auth token for the US, if you route numbers there and it is not your home region |
| `TWILIO_AUTH_TOKEN_IE1` | Auth token for Ireland, if you route numbers there and it is not your home region |
| `TWILIO_AUTH_TOKEN_AU1` | Auth token for Australia, if you route numbers there and it is not your home region |

All of these are managed on Admin > Settings > Twilio - you pick your account's country there
and enter the matching Account SID and auth token; you rarely need to set the env vars by hand.

Use **auth tokens only** (found under Auth tokens on the console's "API keys & tokens" page,
with the right region selected). Twilio **API keys** (SIDs starting with `SK`) are not usable
by this module - webhook signatures are validated against the region's auth token, so an API
key would silently break call forwarding even if REST calls were made to accept it. The
settings tab and the connection test both reject `SK…` values with an explanation.

The number texts are sent from is no longer an environment variable - it is chosen from
the account's numbers on Admin > Settings > Twilio, and only text-capable numbers qualify.

## License

MIT
