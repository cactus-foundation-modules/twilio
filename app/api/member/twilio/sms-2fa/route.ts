// Self-service SMS 2FA for members (their own account only).
// GET    - current state
// POST   - { action: 'send', phone } | { action: 'verify', code }
// DELETE - remove the SMS method (other configured methods take over)
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { getMemberFromCookie } from '@/lib/members/session'
import { errorResponse } from '@/lib/utils'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import { checkAndRecord, getClientIp } from '@/lib/auth/rate-limit'
import { maskPhone } from '@/lib/auth/sms'
import { isSmsReady, sendSiteSms } from '@/modules/twilio/lib/numbers'
import { createPhoneVerification, verifyPhoneCode, normalisePhone } from '@/modules/twilio/lib/verification'

export async function GET() {
  const member = await getMemberFromCookie()
  if (!member) return errorResponse('Not authenticated', 401)

  const config = await prisma.memberTwoFactor.findUnique({
    where: { memberId_method: { memberId: member.id, method: 'SMS' } },
  })
  const phone = config?.verified && config.phoneEncrypted ? decryptSecret(config.phoneEncrypted) : null
  return NextResponse.json({
    available: await isSmsReady(),
    enabled: !!phone,
    maskedPhone: phone ? maskPhone(phone) : null,
  })
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), phone: z.string().min(1) }),
  z.object({ action: z.literal('verify'), code: z.string().min(6).max(6) }),
])

export async function POST(request: NextRequest) {
  const member = await getMemberFromCookie()
  if (!member) return errorResponse('Not authenticated', 401)

  if (!(await isSmsReady())) {
    return errorResponse('Text messaging is not set up - add a text-enabled Twilio number first', 503)
  }

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')

  const ip = await getClientIp(request)
  const rl = await checkAndRecord('member_2fa', [`ip:${ip}`, `twilio_2fa_member:${member.id}`])
  if (!rl.allowed) {
    return errorResponse('Too many attempts. Please wait and try again.', 429)
  }

  if (parsed.data.action === 'send') {
    const phone = normalisePhone(parsed.data.phone)
    if (!phone) {
      return errorResponse('Phone number must be in international format, e.g. +447700900123')
    }
    const code = await createPhoneVerification('member', member.id, phone)
    try {
      await sendSiteSms(phone, `${code} is your verification code.`)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Failed to send text message', 502)
    }
    return NextResponse.json({ sent: true })
  }

  const result = await verifyPhoneCode('member', member.id, parsed.data.code)
  if (!result.success) {
    const message =
      result.reason === 'max_attempts' ? 'Too many incorrect attempts. Start again.' :
      result.reason === 'expired' ? 'Code has expired. Start again.' :
      'Incorrect code'
    return errorResponse(message, 401)
  }

  await prisma.memberTwoFactor.upsert({
    where: { memberId_method: { memberId: member.id, method: 'SMS' } },
    create: {
      memberId: member.id,
      method: 'SMS',
      phoneEncrypted: encryptSecret(result.phone),
      verified: true,
    },
    update: {
      phoneEncrypted: encryptSecret(result.phone),
      verified: true,
    },
  })
  return NextResponse.json({ enabled: true, maskedPhone: maskPhone(result.phone) })
}

export async function DELETE() {
  const member = await getMemberFromCookie()
  if (!member) return errorResponse('Not authenticated', 401)

  await prisma.memberTwoFactor.deleteMany({
    where: { memberId: member.id, method: 'SMS' },
  })
  return NextResponse.json({ enabled: false })
}
