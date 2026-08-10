import { redirect } from 'next/navigation'
import { headers } from 'next/headers'

// The call and text logs are now a sub-tab of Settings > Twilio rather than a
// sidebar link of their own. This route stays put so old bookmarks still land there.
export default async function TwilioAdminRedirect() {
  const adminPath = (await headers()).get('x-cactus-admin-path') ?? 'cactus-admin'
  return redirect(`/${adminPath}/config?tab=twilio`)
}
