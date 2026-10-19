import { z } from 'zod'
import { exec, json, one, parseJson, query } from '../lib/db.js'
import { newId } from '../lib/ids.js'
import { bus, publish } from '../lib/events.js'
import { badRequest, notFound } from '../lib/errors.js'
import { isGroupJid, normalizePhone } from '../lib/phone.js'
import { config } from '../config.js'
import { absolutePath, saveBase64 } from './media.js'
import { logger } from '../lib/logger.js'

export const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'document', 'location']
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document'])

const coerceText = (v) => (v === undefined || v === null ? v : String(v))

export const messageSchema = z.object({
  channel: z.enum(['whatsapp', 'sms', 'auto']).default('auto'),
  to: z.union([z.string(), z.number()]).transform(String),
  type: z.enum(MESSAGE_TYPES).default('text'),
  text: z.preprocess(coerceText, z.string().max(4096).optional()),
  media_url: z.string().url().optional(),
  media_base64: z.string().optional(),
  filename: z.string().max(255).optional(),
  mimetype: z.string().max(120).optional(),
  ptt: z.boolean().optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  location_name: z.string().max(255).optional(),
  address: z.string().max(255).optional(),
  instance_id: z.string().max(40).optional(),
  device_id: z.string().max(40).optional(),
  sim: z.coerce.number().int().min(1).max(4).optional(),
  fallback: z.boolean().optional(),
  scheduled_at: z.coerce.date().optional(),
  reference: z.string().max(191).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  priority: z.number().int().min(0).max(10).optional()
})

// Accept a few aliases used by other gateways (message/body instead of text, phone instead of to)
export function normalizeMessageBody(body = {}) {
  const b = { ...body }
  b.text ??= b.message ?? b.body ?? b.caption
  b.to ??= b.phone ?? b.number ?? b.chatId
  delete b.message
  delete b.body
  delete b.caption
  delete b.phone
  delete b.number
  delete b.chatId
  return b
}

export function presentMessage(row) {
  if (!row) return null
  const extra = parseJson(row.extra, {})
  return {
    id: row.id,
    direction: row.direction === 'in' ? 'inbound' : 'outbound',
    channel: row.channel,
    status: row.status,
    [row.direction === 'in' ? 'from' : 'to']: row.phone,
    type: row.type,
    // never expose OTP codes through the API, logs or webhooks
    text: row.otp_id && row.body ? row.body.replace(/\d{4,10}/g, (m) => '•'.repeat(m.length)) : row.body,
    media_url: row.media_url,
    filename: row.filename,
    mimetype: row.mimetype,
    location: extra.location ?? undefined,
    group: extra.group ?? undefined,
    push_name: extra.push_name ?? undefined,
    instance_id: row.instance_id,
    device_id: row.device_id,
    sim: row.sim,
    provider_id: row.provider_id,
    error: row.error,
    attempts: row.attempts,
    fallback_channel: row.fallback_channel,
    parent_id: row.parent_id,
    fallback_id: row.fallback_id,
    otp_id: row.otp_id,
    reference: row.reference,
    metadata: parseJson(row.metadata),
    scheduled_at: row.scheduled_at,
    sent_at: row.sent_at,
    delivered_at: row.delivered_at,
    read_at: row.read_at,
    failed_at: row.failed_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export const getMessageRow = (id) => one('SELECT * FROM vm_messages WHERE id = ?', [id])

export async function getMessage(id) {
  const row = await getMessageRow(id)
  if (!row) throw notFound('Message')
  return presentMessage(row)
}

function resolveChannel(input) {
  const textOnly = input.type === 'text'
  if (input.channel === 'auto') {
    return { channel: 'whatsapp', fallback: textOnly && input.fallback !== false ? 'sms' : null }
  }
  if (input.channel === 'whatsapp') {
    return { channel: 'whatsapp', fallback: textOnly && input.fallback === true ? 'sms' : null }
  }
  return { channel: 'sms', fallback: input.fallback === true ? 'whatsapp' : null }
}

/**
 * Validates an outgoing message, stores it as `queued` and wakes the dispatcher.
 * Extra internal fields (otp_id, expires_at, priority) can be passed via `internal`.
 */
export async function enqueueMessage(body, { apiKeyId = null, internal = {} } = {}) {
  const parsed = messageSchema.safeParse(normalizeMessageBody(body))
  if (!parsed.success) throw badRequest('Invalid message', parsed.error.issues)
  const input = parsed.data
  const { channel, fallback } = internal.channel
    ? { channel: internal.channel, fallback: internal.fallback ?? null }
    : resolveChannel(input)

  const phone = normalizePhone(input.to)
  if (channel === 'sms' && phone.includes('@')) throw badRequest('SMS requires a phone number, not a WhatsApp JID')
  if (isGroupJid(phone) && fallback) throw badRequest('Groups cannot fall back to SMS')

  if (input.type === 'text' && !input.text?.trim()) throw badRequest('text is required for text messages')
  if (channel === 'sms' && input.type !== 'text') throw badRequest('SMS supports text messages only')
  if (MEDIA_TYPES.has(input.type) && !input.media_url && !input.media_base64) {
    throw badRequest(`media_url or media_base64 is required for ${input.type} messages`)
  }
  if (input.type === 'location' && (input.latitude === undefined || input.longitude === undefined)) {
    throw badRequest('latitude and longitude are required for location messages')
  }

  let mediaPath = null
  let mimetype = input.mimetype ?? null
  if (MEDIA_TYPES.has(input.type) && input.media_base64) {
    const saved = await saveBase64(input.media_base64, { mimetype, filename: input.filename })
    mediaPath = saved.file
    mimetype = saved.mimetype
  }

  const extra = {}
  if (input.type === 'location') {
    extra.location = {
      latitude: input.latitude,
      longitude: input.longitude,
      name: input.location_name,
      address: input.address
    }
  }
  if (input.ptt) extra.ptt = true
  if (input.device_id) extra.device_pinned = true

  const now = new Date()
  const scheduledAt = input.scheduled_at && input.scheduled_at > now ? input.scheduled_at : null
  const row = {
    id: newId('msg'),
    direction: 'out',
    channel,
    instance_id: channel === 'whatsapp' ? (input.instance_id ?? null) : null,
    device_id: channel === 'sms' ? (input.device_id ?? null) : null,
    phone,
    type: input.type,
    body: input.text ?? null,
    media_url: input.media_url ?? null,
    media_path: mediaPath,
    filename: input.filename ?? null,
    mimetype,
    extra: json(Object.keys(extra).length ? extra : null),
    status: 'queued',
    priority: internal.priority ?? input.priority ?? 0,
    max_attempts: internal.max_attempts ?? config.messages.maxAttempts,
    fallback_channel: fallback,
    parent_id: internal.parent_id ?? null,
    otp_id: internal.otp_id ?? null,
    reference: input.reference ?? null,
    metadata: json(input.metadata),
    api_key_id: apiKeyId,
    sim: input.sim ?? null,
    scheduled_at: scheduledAt,
    next_attempt_at: scheduledAt ?? now,
    expires_at: internal.expires_at ?? null,
    created_at: now,
    updated_at: now
  }
  await exec('INSERT INTO vm_messages SET ?', [row])
  bus.emit(channel === 'sms' ? 'sms:queued' : 'wa:queued')
  return presentMessage(row)
}

export async function listMessages(filters = {}) {
  const where = []
  const params = []
  for (const key of ['status', 'channel', 'instance_id', 'device_id', 'reference', 'otp_id']) {
    if (filters[key]) {
      where.push(`${key} = ?`)
      params.push(filters[key])
    }
  }
  if (filters.direction) {
    where.push('direction = ?')
    params.push(filters.direction === 'inbound' || filters.direction === 'in' ? 'in' : 'out')
  }
  if (filters.phone) {
    where.push('phone = ?')
    params.push(normalizePhone(filters.phone))
  }
  if (filters.before) {
    where.push('created_at < ?')
    params.push(new Date(filters.before))
  }
  if (filters.since) {
    where.push('created_at >= ?')
    params.push(new Date(filters.since))
  }
  const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 50, 1), 200)
  const rows = await query(
    `SELECT * FROM vm_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT ?`,
    [...params, limit]
  )
  return rows.map(presentMessage)
}

export async function cancelMessage(id) {
  const res = await exec(
    "UPDATE vm_messages SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'",
    [new Date(), id]
  )
  if (!res.affectedRows) {
    const row = await getMessageRow(id)
    if (!row) throw notFound('Message')
    throw badRequest(`Message is already ${row.status} and cannot be cancelled`)
  }
  return getMessage(id)
}

const RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 }
const STATUS_TIME = { sent: 'sent_at', delivered: 'delivered_at', read: 'read_at' }

/**
 * Moves a message forward to sent/delivered/read. Never moves backwards, so
 * out-of-order receipts (read before delivered) are harmless.
 */
export async function advanceStatus(id, status, extra = {}) {
  const row = await getMessageRow(id)
  if (!row || row.status === 'failed' || row.status === 'cancelled') return null
  if ((RANK[status] ?? -1) <= (RANK[row.status] ?? -1)) return null
  const now = new Date()
  const fields = { status, updated_at: now, error: null, ...extra }
  for (const [s, col] of Object.entries(STATUS_TIME)) {
    if (RANK[s] <= RANK[status] && !row[col]) fields[col] = now
  }
  if (status === 'sent') fields.locked_at = null
  await exec('UPDATE vm_messages SET ? WHERE id = ?', [fields, id])
  const updated = { ...row, ...fields }
  publish(`message.${status}`, presentMessage(updated))
  return updated
}

export async function advanceByProviderId(providerId, status) {
  const row = await one('SELECT id FROM vm_messages WHERE provider_id = ? AND direction = ? LIMIT 1', [
    providerId,
    'out'
  ])
  if (row) await advanceStatus(row.id, status)
}

const retryDelayMs = (attempts) => Math.min(15_000 * 2 ** Math.max(attempts - 1, 0), 10 * 60_000)

/**
 * Handles a failed send attempt: retries with backoff while attempts remain,
 * otherwise marks the message failed and, if configured, re-sends it on the
 * fallback channel (e.g. WhatsApp → SMS for OTPs).
 */
export async function failAttempt(id, error, { permanent = false } = {}) {
  const row = await getMessageRow(id)
  if (!row || ['failed', 'cancelled', 'sent', 'delivered', 'read'].includes(row.status)) return
  const message = String(error?.message ?? error).slice(0, 500)
  const now = new Date()
  const expired = row.expires_at && row.expires_at <= now

  if (!permanent && !expired && row.attempts < row.max_attempts) {
    const extra = parseJson(row.extra, {})
    await exec('UPDATE vm_messages SET ? WHERE id = ?', [
      {
        status: 'queued',
        error: message,
        locked_at: null,
        claim_token: null,
        device_id: row.channel === 'sms' && !extra.device_pinned ? null : row.device_id,
        next_attempt_at: new Date(now.getTime() + retryDelayMs(row.attempts)),
        updated_at: now
      },
      id
    ])
    logger.warn({ id, attempts: row.attempts, error: message }, 'message attempt failed, will retry')
    return
  }

  const fields = { status: 'failed', error: message, failed_at: now, locked_at: null, updated_at: now }
  let fallbackMessage = null
  if (row.fallback_channel && !expired) {
    try {
      fallbackMessage = await enqueueMessage(
        {
          to: row.phone,
          type: row.type,
          text: row.body,
          reference: row.reference ?? undefined,
          metadata: parseJson(row.metadata) ?? undefined
        },
        {
          apiKeyId: row.api_key_id,
          internal: {
            channel: row.fallback_channel,
            parent_id: row.id,
            otp_id: row.otp_id,
            priority: row.priority,
            expires_at: row.expires_at
          }
        }
      )
      fields.fallback_id = fallbackMessage.id
      if (row.otp_id) {
        await exec('UPDATE vm_otps SET message_id = ?, channel = ? WHERE id = ?', [
          fallbackMessage.id,
          row.fallback_channel,
          row.otp_id
        ])
      }
    } catch (err) {
      logger.error({ err, id }, 'could not enqueue fallback message')
    }
  }
  await exec('UPDATE vm_messages SET ? WHERE id = ?', [fields, id])
  logger.warn({ id, error: message, fallback: fallbackMessage?.id }, 'message failed')
  publish('message.failed', presentMessage({ ...row, ...fields }))
}

/** Stores an inbound WhatsApp/SMS message and emits `message.received`. */
export async function recordInbound(data) {
  const now = new Date()
  const row = {
    id: newId('msg'),
    direction: 'in',
    channel: data.channel,
    instance_id: data.instance_id ?? null,
    device_id: data.device_id ?? null,
    phone: data.phone,
    type: data.type ?? 'text',
    body: data.body ?? null,
    media_url: data.media_url ?? null,
    media_path: data.media_path ?? null,
    filename: data.filename ?? null,
    mimetype: data.mimetype ?? null,
    extra: json(data.extra),
    status: 'received',
    provider_id: data.provider_id ?? null,
    sim: data.sim ?? null,
    max_attempts: 0,
    sent_at: data.received_at ?? now,
    created_at: now,
    updated_at: now
  }
  await exec('INSERT INTO vm_messages SET ?', [row])
  const presented = presentMessage(row)
  publish('message.received', presented)
  return presented
}

export const mediaFileFor = (row) => (row.media_path ? absolutePath(row.media_path) : null)

export async function messageStats() {
  const since = new Date(Date.now() - 24 * 3600 * 1000)
  const rows = await query(
    `SELECT channel, direction, status, COUNT(*) AS total FROM vm_messages
     WHERE created_at >= ? GROUP BY channel, direction, status`,
    [since]
  )
  return rows.map((r) => ({ ...r, direction: r.direction === 'in' ? 'inbound' : 'outbound', total: Number(r.total) }))
}
