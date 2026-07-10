// Phone verification codes for SMS 2FA enrolment. Module-owned equivalent of
// core's email challenges: hashed 6-digit code, 10-minute TTL, 5 attempts.
import { createHash, randomInt } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import { safeCompare } from '@/lib/auth/session'

const CODE_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

export type SubjectType = 'user' | 'member'

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export async function createPhoneVerification(
  subjectType: SubjectType,
  subjectId: string,
  phone: string
): Promise<string> {
  const code = generateCode()
  const codeHash = hashCode(code)
  const phoneEncrypted = encryptSecret(phone)
  const expiresAt = new Date(Date.now() + CODE_TTL_MS)

  await prisma.$executeRaw`
    INSERT INTO "tw_verification_codes" (subject_type, subject_id, phone_encrypted, code_hash, expires_at)
    VALUES (${subjectType}, ${subjectId}, ${phoneEncrypted}, ${codeHash}, ${expiresAt})
    ON CONFLICT (subject_type, subject_id) DO UPDATE SET
      phone_encrypted = EXCLUDED.phone_encrypted,
      code_hash       = EXCLUDED.code_hash,
      attempts        = 0,
      expires_at      = EXCLUDED.expires_at,
      created_at      = CURRENT_TIMESTAMP
  `
  return code
}

export type VerifyResult =
  | { success: true; phone: string }
  | { success: false; reason: 'invalid' | 'expired' | 'max_attempts' }

export async function verifyPhoneCode(
  subjectType: SubjectType,
  subjectId: string,
  code: string
): Promise<VerifyResult> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, phone_encrypted, code_hash, attempts, expires_at FROM "tw_verification_codes"
    WHERE subject_type = ${subjectType} AND subject_id = ${subjectId}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return { success: false, reason: 'invalid' }

  const id = row.id as string
  if ((row.expires_at as Date) < new Date()) {
    await prisma.$executeRaw`DELETE FROM "tw_verification_codes" WHERE id = ${id}`
    return { success: false, reason: 'expired' }
  }
  const attempts = row.attempts as number
  if (attempts >= MAX_ATTEMPTS) {
    await prisma.$executeRaw`DELETE FROM "tw_verification_codes" WHERE id = ${id}`
    return { success: false, reason: 'max_attempts' }
  }

  if (!safeCompare(hashCode(code.trim()), row.code_hash as string)) {
    await prisma.$executeRaw`UPDATE "tw_verification_codes" SET attempts = attempts + 1 WHERE id = ${id}`
    if (attempts + 1 >= MAX_ATTEMPTS) {
      await prisma.$executeRaw`DELETE FROM "tw_verification_codes" WHERE id = ${id}`
    }
    return { success: false, reason: 'invalid' }
  }

  const phone = decryptSecret(row.phone_encrypted as string)
  await prisma.$executeRaw`DELETE FROM "tw_verification_codes" WHERE id = ${id}`
  return { success: true, phone }
}

// E.164: leading + then 8-15 digits. Strict on purpose - Twilio rejects
// anything else anyway, better to catch it before sending.
export function normalisePhone(input: string): string | null {
  const cleaned = input.replace(/[\s()-]/g, '')
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null
}
