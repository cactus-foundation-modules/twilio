// GET/POST/DELETE /api/m/twilio/admin/blocked-numbers - the callers this site
// refuses. GET lists them, POST adds one, DELETE takes one off again.
//
// Blocking is a permission on its own account rather than a side effect of
// being able to read the call log: it changes what the site does to the next
// person who rings, so it takes the same permission as the rest of the number's
// configuration.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  NotBlockableError,
  blockNumber,
  listBlockedNumbers,
  unblockNumber,
} from '@/modules/twilio/lib/blocked-numbers'

// Signed in, and allowed to change what happens to the next caller. Returns the
// refusal itself rather than throwing, so each handler can hand it straight
// back: a discriminated result rather than an instanceof test, because
// errorResponse and NextResponse.json are both plain Responses and telling them
// apart afterwards is not something the types can do.
type Guarded = { ok: true; userId: string } | { ok: false; response: Response }

async function guard(): Promise<Guarded> {
  const user = await getSessionFromCookie()
  if (!user) return { ok: false, response: errorResponse('Not authenticated', 401) }
  if (!(await hasPermission(user, 'twilio.manage'))) {
    return { ok: false, response: errorResponse('Forbidden', 403) }
  }
  return { ok: true, userId: user.id }
}

export async function GET() {
  const check = await guard()
  if (!check.ok) return check.response

  const blocked = await listBlockedNumbers()
  return NextResponse.json({
    blocked: blocked.map((b) => ({
      phoneNumber: b.phoneNumber,
      reason: b.reason,
      blockedByName: b.blockedByName,
      createdAt: b.createdAt.toISOString(),
    })),
  })
}

export async function POST(request: NextRequest) {
  const check = await guard()
  if (!check.ok) return check.response

  const body = (await request.json().catch(() => null)) as
    | { phoneNumber?: unknown; reason?: unknown }
    | null
  const phoneNumber = typeof body?.phoneNumber === 'string' ? body.phoneNumber : ''
  const reason = typeof body?.reason === 'string' ? body.reason : ''

  try {
    const number = await blockNumber({ phoneNumber, reason, blockedBy: check.userId })
    return NextResponse.json({ ok: true, phoneNumber: number })
  } catch (err) {
    // A withheld caller is a refusal with an explanation, not a fault: the
    // person asked for something the site cannot honestly do, and the message
    // says what to do instead.
    if (err instanceof NotBlockableError) return errorResponse(err.message, 400)
    throw err
  }
}

export async function DELETE(request: NextRequest) {
  const check = await guard()
  if (!check.ok) return check.response

  const phoneNumber = request.nextUrl.searchParams.get('number') ?? ''
  try {
    const number = await unblockNumber(phoneNumber)
    return NextResponse.json({ ok: true, phoneNumber: number })
  } catch (err) {
    if (err instanceof NotBlockableError) return errorResponse('That is not a number this site could have blocked.', 400)
    throw err
  }
}
