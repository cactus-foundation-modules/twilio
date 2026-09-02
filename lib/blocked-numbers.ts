// Callers this site will not take calls from.
//
// The whole feature is one question asked at one moment: the voice webhook
// wants to know, before it does anything else, whether the number ringing is
// one somebody has had enough of. Everything else here exists to let a person
// answer that question and change their mind about it later.
//
// WHAT BLOCKING IS NOT. It does not delete anything. The calls and texts
// already in the log stay exactly where they are, because a nuisance caller is
// often precisely the person whose history somebody needs to keep. Getting rid
// of the record is a separate decision with its own button.
//
// WITHHELD CALLERS CANNOT BE BLOCKED. There is nothing to write down: the next
// withheld call is not the same caller in any sense the site can check, so a
// row here would block every withheld caller at once while claiming to block
// one. Each number's own `anonymous_callers` rule already offers that choice
// honestly, and this refuses rather than pretending.
import { prisma } from '@/lib/db/prisma'
import { normalisePhone } from './verification'

export type BlockedNumber = {
  phoneNumber: string
  reason: string
  blockedBy: string | null
  blockedByName: string | null
  createdAt: Date
}

/** Thrown when there is no number to act on - a withheld caller, or something
 *  that is not a phone number at all. The message is shown to a person, so it
 *  says what to do instead rather than naming the format it wanted. */
export class NotBlockableError extends Error {
  constructor(message = 'A withheld number cannot be blocked - there is nothing to keep. Use the number\'s own setting for withheld callers instead.') {
    super(message)
    this.name = 'NotBlockableError'
  }
}

/**
 * Is this caller blocked?
 *
 * Called on the hot path of every inbound call, so it is one indexed lookup on
 * the primary key and nothing else. Anything that is not an E.164 number - a
 * withheld caller, an empty From - answers false without touching the database:
 * nothing can be stored against it, so nothing can match it.
 */
export async function isNumberBlocked(from: string | null | undefined): Promise<boolean> {
  const number = normalisePhone(from ?? '')
  if (!number) return false
  const rows = await prisma.$queryRaw<Array<{ phone_number: string }>>`
    SELECT "phone_number" FROM "tw_blocked_numbers" WHERE "phone_number" = ${number} LIMIT 1
  `
  return rows.length > 0
}

/** Everyone currently blocked, newest first, with the name of whoever did it
 *  where that person is still on the site. */
export async function listBlockedNumbers(): Promise<BlockedNumber[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT b."phone_number", b."reason", b."blocked_by", b."created_at",
           u."displayName" AS "blocked_by_name", u."username" AS "blocked_by_username"
      FROM "tw_blocked_numbers" b
      LEFT JOIN "User" u ON u."id" = b."blocked_by"
     ORDER BY b."created_at" DESC
  `
  return rows.map((r) => ({
    phoneNumber: r.phone_number as string,
    reason: (r.reason as string) ?? '',
    blockedBy: (r.blocked_by as string | null) ?? null,
    blockedByName:
      (r.blocked_by_name as string | null) || (r.blocked_by_username as string | null) || null,
    createdAt: r.created_at as Date,
  }))
}

/**
 * Refuse this number from now on.
 *
 * Blocking somebody already blocked is not an error - the outcome asked for is
 * the outcome already in place - so the row is left as it stands rather than
 * having its reason and its author rewritten by whoever pressed it second.
 */
export async function blockNumber(input: {
  phoneNumber: string
  reason?: string
  blockedBy?: string | null
}): Promise<string> {
  const number = normalisePhone(input.phoneNumber)
  if (!number) throw new NotBlockableError()
  await prisma.$executeRaw`
    INSERT INTO "tw_blocked_numbers" ("phone_number", "reason", "blocked_by")
    VALUES (${number}, ${(input.reason ?? '').slice(0, 500)}, ${input.blockedBy ?? null})
    ON CONFLICT ("phone_number") DO NOTHING
  `
  return number
}

/** Let them through again. Unblocking somebody who was never blocked is not an
 *  error either - it is the same outcome either way. */
export async function unblockNumber(phoneNumber: string): Promise<string> {
  const number = normalisePhone(phoneNumber)
  if (!number) throw new NotBlockableError()
  await prisma.$executeRaw`
    DELETE FROM "tw_blocked_numbers" WHERE "phone_number" = ${number}
  `
  return number
}
