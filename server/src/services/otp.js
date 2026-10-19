import crypto from 'node:crypto'
import { z } from 'zod'
import { config } from '../config.js'
import { exec, one, query } from '../lib/db.js'
import { newId } from '../lib/ids.js'
import { hmac, safeEqual } from '../lib/crypto.js'
import { publish } from '../lib/events.js'
import { badRequest, notFound, tooMany } from '../lib/errors.js'
import { normalizePhone } from '../lib/phone.js'
import { enqueueMessage } from './messages.js'

export const sendSchema = z.object({
  phone: z.union([z.string(), z.number()]).transform(String),
  channel: z.enum(['auto', 'whatsapp', 'sms']).default('auto'),
  purpose: z
    .string()
    .max(64)
    .regex(/^[\w.:-]+$/)
    .default('default'),
  length: z.number().int().min(4).max(10).optional(),
  alphabet: z.enum(['digits', 'letters', 'letters_upper', 'alnum', 'alnum_upper']).default('digits'),
  expires_in: z.number().int().min(30).max(3600).optional(),
  template: z.string().max(1000).optional(),
  instance_id: z.string().optional(),
  reference: z.string().max(191).optional()
})

export const verifySchema = z.object({
  phone: z.union([z.string(), z.number()]).transform(String).optional(),
  otp_id: z.string().optional(),
  purpose: z.string().max(64).default('default'),
  code: z.union([z.string(), z.number()]).transform((v) => String(v).replace(/\s/g, ''))
})

const codeHash = (otpId, code) => hmac(`otp:${otpId}:${code}`)

const ALPHABETS = {
  digits: '0123456789',
  letters: 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ',
  letters_upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  // no 0/O, 1/I/l: easy to read and type
  alnum: '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ',
  alnum_upper: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
}

function generateCode(length, alphabet = 'digits') {
  const chars = ALPHABETS[alphabet]
  let code = ''
  for (let i = 0; i < length; i++) code += chars[crypto.randomInt(0, chars.length)]
  return code
}

function present(row) {
  return {
    id: row.id,
    phone: row.phone,
    purpose: row.purpose,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    message_id: row.message_id,
    reference: row.reference,
    expires_at: row.expires_at,
    verified_at: row.verified_at,
    created_at: row.created_at
  }
}

/** `revealCode` returns the code to the caller (Hypersender-compatible API only). */
export async function sendOtp(body, { apiKeyId, ip, revealCode = false } = {}) {
  const parsed = sendSchema.safeParse(body)
  if (!parsed.success) throw badRequest('Invalid OTP request', parsed.error.issues)
  const input = parsed.data
  const phone = normalizePhone(input.phone)
  if (phone.includes('@')) throw badRequest('phone must be a phone number')
  const now = new Date()

  const last = await one(
    'SELECT created_at FROM vm_otps WHERE phone = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
    [phone, input.purpose]
  )
  if (last) {
    const wait = Math.ceil((last.created_at.getTime() + config.otp.resendCooldownSec * 1000 - now.getTime()) / 1000)
    if (wait > 0) throw tooMany(`Please wait ${wait}s before requesting a new code`, { retry_after: wait })
  }
  const hourly = await one('SELECT COUNT(*) AS c FROM vm_otps WHERE phone = ? AND created_at >= ?', [
    phone,
    new Date(now - 3600 * 1000)
  ])
  if (Number(hourly.c) >= config.otp.maxPerHour) {
    throw tooMany('Too many codes requested for this number, try again later', { retry_after: 3600 })
  }

  // a new code always invalidates the previous one for the same purpose
  await exec("UPDATE vm_otps SET status = 'replaced' WHERE phone = ? AND purpose = ? AND status = 'pending'", [
    phone,
    input.purpose
  ])

  const length = input.length ?? config.otp.length
  const ttl = input.expires_in ?? config.otp.ttlSec
  const code = generateCode(length, input.alphabet)
  const id = newId('otp')
  const expiresAt = new Date(now.getTime() + ttl * 1000)
  const text = (input.template || config.otp.template)
    .replaceAll('{code}', code)
    .replaceAll('{minutes}', String(Math.max(1, Math.round(ttl / 60))))
    .replaceAll('{app}', config.appName)
  if (!text.includes(code)) throw badRequest('template must contain {code}')

  await exec('INSERT INTO vm_otps SET ?', [
    {
      id,
      phone,
      purpose: input.purpose,
      code_hash: codeHash(id, code),
      channel: input.channel === 'sms' ? 'sms' : 'whatsapp',
      max_attempts: config.otp.maxAttempts,
      reference: input.reference ?? null,
      ip: ip ?? null,
      expires_at: expiresAt,
      created_at: now
    }
  ])

  let message
  try {
    message = await enqueueMessage(
      {
        to: phone,
        channel: input.channel,
        text,
        instance_id: input.instance_id,
        reference: input.reference
      },
      {
        apiKeyId,
        internal: {
          otp_id: id,
          priority: 10,
          expires_at: expiresAt,
          ...(input.channel === 'auto'
            ? { channel: 'whatsapp', fallback: 'sms' }
            : { channel: input.channel, fallback: null })
        }
      }
    )
  } catch (err) {
    await exec('DELETE FROM vm_otps WHERE id = ?', [id])
    throw err
  }
  await exec('UPDATE vm_otps SET message_id = ? WHERE id = ?', [message.id, id])

  return {
    id,
    phone,
    purpose: input.purpose,
    channel: message.channel,
    fallback_channel: message.fallback_channel,
    message_id: message.id,
    expires_at: expiresAt,
    created_at: now,
    resend_after: config.otp.resendCooldownSec,
    ...(revealCode ? { code } : {})
  }
}

export async function verifyOtp(body) {
  const parsed = verifySchema.safeParse(body)
  if (!parsed.success) throw badRequest('Invalid verification request', parsed.error.issues)
  const input = parsed.data
  if (!input.otp_id && !input.phone) throw badRequest('phone or otp_id is required')

  const row = input.otp_id
    ? await one('SELECT * FROM vm_otps WHERE id = ?', [input.otp_id])
    : await one(
        "SELECT * FROM vm_otps WHERE phone = ? AND purpose = ? AND status IN ('pending','verified','expired','failed') ORDER BY created_at DESC LIMIT 1",
        [normalizePhone(input.phone), input.purpose]
      )

  if (!row) return { valid: false, reason: 'not_found' }
  if (row.status === 'verified') return { valid: false, reason: 'already_used', otp_id: row.id }
  if (row.status === 'replaced') return { valid: false, reason: 'replaced', otp_id: row.id }
  if (row.status === 'failed') return { valid: false, reason: 'too_many_attempts', otp_id: row.id }
  if (row.status === 'expired' || row.expires_at <= new Date()) {
    await exec("UPDATE vm_otps SET status = 'expired' WHERE id = ? AND status = 'pending'", [row.id])
    return { valid: false, reason: 'expired', otp_id: row.id }
  }

  // count the attempt atomically before comparing, so parallel guesses cannot exceed the limit
  const counted = await exec(
    "UPDATE vm_otps SET attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts < max_attempts",
    [row.id]
  )
  if (!counted.affectedRows) {
    await exec("UPDATE vm_otps SET status = 'failed' WHERE id = ? AND status = 'pending'", [row.id])
    return { valid: false, reason: 'too_many_attempts', otp_id: row.id }
  }
  const attempts = row.attempts + 1

  if (safeEqual(codeHash(row.id, input.code), row.code_hash)) {
    const res = await exec(
      "UPDATE vm_otps SET status = 'verified', verified_at = ? WHERE id = ? AND status = 'pending'",
      [new Date(), row.id]
    )
    if (!res.affectedRows) return { valid: false, reason: 'already_used', otp_id: row.id }
    const verified = present({ ...row, status: 'verified', attempts, verified_at: new Date() })
    publish('otp.verified', verified)
    return { valid: true, otp_id: row.id, phone: row.phone, purpose: row.purpose, reference: row.reference }
  }

  const left = row.max_attempts - attempts
  if (left <= 0) await exec("UPDATE vm_otps SET status = 'failed' WHERE id = ? AND status = 'pending'", [row.id])
  return { valid: false, reason: 'invalid_code', otp_id: row.id, attempts_left: Math.max(left, 0) }
}

export async function getOtp(id) {
  const row = await one('SELECT * FROM vm_otps WHERE id = ?', [id])
  if (!row) throw notFound('OTP')
  return present(row)
}

export async function listOtps(limit = 50) {
  const rows = await query('SELECT * FROM vm_otps ORDER BY created_at DESC LIMIT ?', [
    Math.min(Number(limit) || 50, 200)
  ])
  return rows.map(present)
}
