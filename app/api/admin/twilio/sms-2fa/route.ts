// Self-service SMS login codes for admin users (their own account only).
// GET    - current state (enabled + masked phone)
// POST   - { action: 'send', phone } text a verification code
//          { action: 'verify', code } confirm and enable
// DELETE - disable SMS codes, reverting login OTPs to email
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import { checkAndRecord, getClientIp } from '@/lib/auth/rate-limit'
import { maskPhone } from '@/lib/auth/sms'
import { isTwilioConfigured, sendSms } from '@/modules/twilio/lib/twilio'
import { createPhoneVerification, verifyPhoneCode, normalisePhone } from '@/modules/twilio/lib/verification'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: { smsOtpPhoneEncrypted: true },
  })
  const phone = record?.smsOtpPhoneEncrypted ? decryptSecret(record.smsOtpPhoneEncrypted) : null
  return NextResponse.json({
    available: isTwilioConfigured(),
    enabled: !!phone,
    maskedPhone: phone ? maskPhone(phone) : null,
  })
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), phone: z.string().min(1) }),
  z.object({ action: z.literal('verify'), code: z.string().min(6).max(6) }),
])

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured', 503)
  }

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')

  const ip = await getClientIp(request)
  const rl = await checkAndRecord('email_code', [`ip:${ip}`, `twilio_2fa_user:${user.id}`])
  if (!rl.allowed) {
    return errorResponse('Too many attempts. Please wait and try again.', 429)
  }

  if (parsed.data.action === 'send') {
    const phone = normalisePhone(parsed.data.phone)
    if (!phone) {
      return errorResponse('Phone number must be in international format, e.g. +447700900123')
    }
    const code = await createPhoneVerification('user', user.id, phone)
    try {
      await sendSms(phone, `${code} is your verification code.`)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Failed to send text message', 502)
    }
    return NextResponse.json({ sent: true })
  }

  const result = await verifyPhoneCode('user', user.id, parsed.data.code)
  if (!result.success) {
    const message =
      result.reason === 'max_attempts' ? 'Too many incorrect attempts. Start again.' :
      result.reason === 'expired' ? 'Code has expired. Start again.' :
      'Incorrect code'
    return errorResponse(message, 401)
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { smsOtpPhoneEncrypted: encryptSecret(result.phone) },
  })
  return NextResponse.json({ enabled: true, maskedPhone: maskPhone(result.phone) })
}

export async function DELETE() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)

  await prisma.user.update({
    where: { id: user.id },
    data: { smsOtpPhoneEncrypted: null },
  })
  return NextResponse.json({ enabled: false })
}
