import { Router } from 'express'
import multer from 'multer'
import { config } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { HttpError } from '../lib/errors.js'
import { normalizePhone } from '../lib/phone.js'
import { one, query } from '../lib/db.js'
import { cancelMessage, enqueueMessage, presentMessage } from '../services/messages.js'
import { connectedSessions, session as waSession } from '../services/whatsapp/manager.js'
import { sendOtp, verifyOtp } from '../services/otp.js'
import {
  chatIdToPhone,
  notOnWhatsappError,
  phoneToChatId,
  smsMessageObject,
  smsPhoneObject,
  waSendResponse
} from '../services/hypersender.js'

/**
 * Hypersender-compatible API: the same paths, bodies and responses as
 * app.hypersender.com, so an app using Hypersender (or its Laravel SDK) only
 * needs its base URL and API key changed. Authentication: our API key as Bearer.
 *
 *   /api/whatsapp/v2/{instance}/send-text …   /api/otp/v2/{instance}/request-code …
 *   /api/sms/v1/{instance}/send-message …
 *
 * {instance} may be one of our WhatsApp instance / SMS phone ids, or anything
 * else (then the default instance / any online phone is used).
 */
const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.media.maxBytes } })
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const apiKeyId = (req) => req.auth.apiKey?.id ?? null

class CompatError extends Error {
  constructor(status, body) {
    super(body.message)
    this.status = status
    this.body = body
  }
}

const phoneFromChat = (chatId) => {
  if (!chatId)
    throw new CompatError(422, { message: 'The chat id field is required.', errors: { chatId: ['required'] } })
  return normalizePhone(chatIdToPhone(chatId))
}

// ---------------------------------------------------------------- WhatsApp

function whatsappSession(instance) {
  try {
    const s = waSession(instance)
    if (s.connected) return s
  } catch {
    // not one of our ids: use the default / first connected instance
  }
  return connectedSessions()[0] ?? null
}

const MEDIA_ACTIONS = { 'send-image': 'image', 'send-file': 'document', 'send-video': 'video', 'send-voice': 'audio' }
const NOOP_ACTIONS = new Set(['send-seen', 'read-chat', 'start-typing', 'stop-typing'])

router.post(
  '/whatsapp/:version/:instance/:action',
  requireAuth,
  upload.single('file'),
  wrap(async (req, res) => {
    const { action, instance } = req.params
    const b = req.body ?? {}
    if (NOOP_ACTIONS.has(action)) return res.json({ result: true })

    let message
    if (action === 'send-text' || action === 'send-text-safe') {
      message = { type: 'text', text: b.text }
    } else if (MEDIA_ACTIONS[action]) {
      message = {
        type: MEDIA_ACTIONS[action],
        text: b.caption ?? undefined,
        media_url: b.url ?? undefined,
        filename: b.filename ?? req.file?.originalname ?? undefined,
        mimetype: b.mimetype ?? req.file?.mimetype ?? undefined,
        ptt: action === 'send-voice' ? true : undefined
      }
      if (req.file) message.media_base64 = req.file.buffer.toString('base64')
    } else if (action === 'send-location') {
      message = { type: 'location', latitude: b.latitude, longitude: b.longitude, location_name: b.title ?? undefined }
    } else {
      throw new CompatError(501, { message: `"${action}" is not supported by Veta Messenger.` })
    }

    const phone = phoneFromChat(b.chatId)
    const s = whatsappSession(instance)
    if (!s) throw new CompatError(503, { message: 'No connected WhatsApp instance.' })
    // Hypersender answers 422 right away when the number has no WhatsApp; apps rely on it to fall back to SMS
    if (!phone.includes('@') && !(await s.exists(phone))) throw new CompatError(422, notOnWhatsappError(phone))

    const msg = await enqueueMessage(
      { ...message, to: phone, channel: 'whatsapp', fallback: false, instance_id: s.id },
      { apiKeyId: apiKeyId(req) }
    )
    res.json(waSendResponse(msg))
  })
)

// ---------------------------------------------------------------- OTP

const OTP_PURPOSE = 'hypersender'

router.post(
  '/otp/:version/:instance/request-code',
  requireAuth,
  wrap(async (req, res) => {
    const b = req.body ?? {}
    const phone = phoneFromChat(b.chatId)
    const letters = b.useLetter === true || b.useLetter === 'true' || b.useLetter === 1
    const numbers = !(b.useNumber === false || b.useNumber === 'false' || b.useNumber === 0)
    const upper = b.allCapital === true || b.allCapital === 'true' || b.allCapital === 1
    const alphabet = letters ? `${numbers ? 'alnum' : 'letters'}${upper ? '_upper' : ''}` : 'digits'
    // Hypersender's unit is not documented: small values are minutes, larger ones seconds
    const expires = Number(b.expires)
    const ttl = Number.isFinite(expires) && expires > 0 ? (expires <= 60 ? expires * 60 : expires) : config.otp.ttlSec
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : config.appName

    let otp
    try {
      otp = await sendOtp(
        {
          phone,
          channel: 'auto',
          purpose: OTP_PURPOSE,
          length: Math.min(Math.max(Number(b.length) || config.otp.length, 4), 10),
          alphabet,
          expires_in: Math.min(Math.max(Math.round(ttl), 30), 3600),
          template: config.otp.template.replaceAll('{app}', name)
        },
        { apiKeyId: apiKeyId(req), revealCode: true }
      )
    } catch (err) {
      if (err.status === 429) throw new CompatError(429, { success: false, message: err.message })
      throw err
    }
    res.json({
      success: true,
      message: 'OTP code generated and message queued successfully',
      data: {
        uuid: otp.id,
        chat_id: phoneToChatId(phone),
        code: otp.code,
        status: 'pending',
        otp_type: 'code',
        expires_at: otp.expires_at,
        created_at: otp.created_at
      }
    })
  })
)

const OTP_REASONS = {
  invalid_code: 'The OTP code is invalid.',
  expired: 'The OTP code has expired.',
  too_many_attempts: 'Too many invalid attempts, request a new code.',
  already_used: 'The OTP code was already used.',
  replaced: 'A newer OTP code was requested.',
  not_found: 'No OTP code found for this chat.'
}

router.post(
  '/otp/:version/:instance/validate-code',
  requireAuth,
  wrap(async (req, res) => {
    const b = req.body ?? {}
    const phone = phoneFromChat(b.chatId)
    const result = await verifyOtp({ phone, code: String(b.code ?? ''), purpose: OTP_PURPOSE })
    if (!result.valid) {
      throw new CompatError(422, {
        success: false,
        message: OTP_REASONS[result.reason] ?? 'Invalid OTP code.',
        data: { uuid: result.otp_id ?? null, chat_id: phoneToChatId(phone), status: result.reason }
      })
    }
    res.json({
      success: true,
      message: 'OTP code validated successfully',
      data: { uuid: result.otp_id, chat_id: phoneToChatId(phone), status: 'validated', validated_at: new Date() }
    })
  })
)

// ---------------------------------------------------------------- SMS

async function devicePin(instance) {
  return (await one('SELECT id FROM vm_sms_devices WHERE id = ?', [instance]))?.id
}

async function deviceRow(id) {
  return id ? one('SELECT * FROM vm_sms_devices WHERE id = ?', [id]) : null
}

function paginate(req, data, total, perPage, page) {
  const lastPage = Math.max(Math.ceil(total / perPage), 1)
  const url = (p) => `${req.protocol}://${req.get('host')}${req.baseUrl}${req.path}?per_page=${perPage}&page=${p}`
  return {
    data,
    links: {
      first: url(1),
      last: url(lastPage),
      prev: page > 1 ? url(page - 1) : null,
      next: page < lastPage ? url(page + 1) : null
    },
    meta: {
      current_page: page,
      from: total ? (page - 1) * perPage + 1 : null,
      last_page: lastPage,
      per_page: perPage,
      to: (page - 1) * perPage + data.length,
      total
    }
  }
}

const pageParams = (req) => {
  const perPage = Math.min(Math.max(Number.parseInt(req.query.per_page, 10) || 15, 1), 100)
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1)
  return { perPage, page, offset: (page - 1) * perPage }
}

router.post(
  '/sms/:version/:instance/send-message',
  requireAuth,
  wrap(async (req, res) => {
    const b = req.body ?? {}
    if (!b.content)
      throw new CompatError(422, { message: 'The content field is required.', errors: { content: ['required'] } })
    if (!b.to) throw new CompatError(422, { message: 'The to field is required.', errors: { to: ['required'] } })
    const expiresIn = Number(b.message_expiration_seconds)
    const maxAttempts = Number(b.max_send_attempts)
    const msg = await enqueueMessage(
      {
        to: b.to,
        channel: 'sms',
        text: b.content,
        reference: b.request_id ? String(b.request_id).slice(0, 191) : undefined,
        scheduled_at: b.schedule_send_at || undefined,
        device_id: await devicePin(req.params.instance)
      },
      {
        apiKeyId: apiKeyId(req),
        internal: {
          channel: 'sms',
          fallback: null,
          ...(Number.isFinite(maxAttempts) && maxAttempts > 0 ? { max_attempts: Math.min(maxAttempts, 20) } : {}),
          ...(Number.isFinite(expiresIn) && expiresIn > 0
            ? {
                expires_at: new Date(
                  Math.max(Date.now(), new Date(b.schedule_send_at || Date.now()).getTime()) + expiresIn * 1000
                )
              }
            : {})
        }
      }
    )
    res.json(smsMessageObject(msg, await deviceRow(msg.device_id)))
  })
)

router.get(
  '/sms/:version/:instance/messages',
  requireAuth,
  wrap(async (req, res) => {
    const { perPage, page, offset } = pageParams(req)
    const where = ["channel = 'sms'"]
    const params = []
    const pin = await devicePin(req.params.instance)
    if (pin) {
      where.push('device_id = ?')
      params.push(pin)
    }
    const total = Number((await one(`SELECT COUNT(*) AS c FROM vm_messages WHERE ${where.join(' AND ')}`, params)).c)
    const rows = await query(
      `SELECT * FROM vm_messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, perPage, offset]
    )
    res.json(
      paginate(
        req,
        rows.map((r) => smsMessageObject(presentMessage(r))),
        total,
        perPage,
        page
      )
    )
  })
)

router.delete(
  '/sms/:version/:instance/delete-message',
  requireAuth,
  wrap(async (req, res) => {
    const id = req.query.message_id ?? req.body?.message_id
    if (!id) throw new CompatError(422, { message: 'The message id field is required.' })
    const msg = await cancelMessage(String(id))
    res.json(smsMessageObject(msg))
  })
)

router.get(
  '/sms/:version/:instance/heartbeats',
  requireAuth,
  wrap(async (req, res) => {
    const { perPage, page, offset } = pageParams(req)
    const pin = await devicePin(req.params.instance)
    const rows = await query(
      `SELECT * FROM vm_sms_devices ${pin ? 'WHERE id = ?' : ''} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`,
      pin ? [pin, perPage, offset] : [perPage, offset]
    )
    const data = rows.map((d) => ({
      id: `hb_${d.id}`,
      phone_id: d.id,
      battery_level: d.battery,
      is_charging: d.charging === null ? null : Boolean(d.charging),
      local_timestamp: d.last_seen_at,
      app_version: d.app_version,
      phone: smsPhoneObject(d),
      created_at: d.last_seen_at,
      updated_at: d.last_seen_at
    }))
    res.json(paginate(req, data, data.length + offset, perPage, page))
  })
)

router.get(
  '/sms/:version/:instance/message-threads',
  requireAuth,
  wrap(async (req, res) => {
    const { perPage, page, offset } = pageParams(req)
    const rows = await query(
      `SELECT m.* FROM vm_messages m
       JOIN (SELECT phone, MAX(created_at) AS last FROM vm_messages WHERE channel = 'sms' GROUP BY phone) t
         ON t.phone = m.phone AND t.last = m.created_at
       WHERE m.channel = 'sms' ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      [perPage, offset]
    )
    const total = Number((await one("SELECT COUNT(DISTINCT phone) AS c FROM vm_messages WHERE channel = 'sms'")).c)
    const data = rows.map((r) => {
      const m = presentMessage(r)
      const other = m.to ?? m.from
      return {
        id: `thread_${other}`,
        phone_id: m.device_id,
        last_message_id: m.id,
        from_phone_number: m.direction === 'inbound' ? other : null,
        to_phone_number: m.direction === 'inbound' ? null : `+${other}`,
        is_archived: false,
        last_message_content: m.text,
        last_message_at: m.created_at,
        created_at: m.created_at,
        updated_at: m.updated_at
      }
    })
    res.json(paginate(req, data, total, perPage, page))
  })
)

router.all('/sms/:version/:instance/*rest', requireAuth, (req) => {
  throw new CompatError(501, {
    message: `"${req.params.rest?.join?.('/') ?? 'endpoint'}" is not supported by Veta Messenger.`
  })
})
router.all('/otp/:version/:instance/*rest', requireAuth, (req) => {
  throw new CompatError(501, {
    message: `"${req.params.rest?.join?.('/') ?? 'endpoint'}" is not supported by Veta Messenger.`
  })
})

// Hypersender-style errors: { message, errors? } with the HTTP status
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof CompatError) return res.status(err.status).json(err.body)
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, ...(err.details ? { errors: err.details } : {}) })
  }
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'The file is too large.' })
  next(err)
})

export default router
