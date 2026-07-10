import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import TwilioAdminScreen from '@/modules/twilio/components/admin/TwilioAdminScreen'

export const metadata = { title: 'Twilio — Admin' }

export default async function TwilioAdminPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  if (!(await hasPermission(user, 'twilio.manage'))) {
    return <div className="alert alert-danger">You do not have permission to manage Twilio.</div>
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Twilio</h1>
      </div>
      <TwilioAdminScreen />
    </div>
  )
}
