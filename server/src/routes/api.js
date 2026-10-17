import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { badRequest } from '../lib/errors.js'
import { createLimiter } from '../lib/rate-limit.js'
import { tooMany } from '../lib/errors.js'
import { cancelMessage, enqueueMessage, getMessage, listMessages, messageStats } from '../services/messages.js'
import * as wa from '../services/whatsapp/manager.js'
import * as devices from '../services/devices.js'
import * as webhooks from '../services/webhooks.js'
import { getOtp, listOtps, sendOtp, verifyOtp } from '../services/otp.js'
import { createApiKey, listApiKeys, revokeApiKey } from '../services/api-keys.js'

const router = Router()
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })

const otpVerifyLimiter = createLimiter({ windowMs: 60_000, max: 30 })

router.use(requireAuth)

const apiKeyId = (req) => req.auth.apiKey?.id ?? null

// ---- status ---------------------------------------------------------------
router.get(
  '/status',
  wrap(async (_req, res) => {
    const [instances, smsDevices, stats] = await Promise.all([
      wa.listInstances(),
      devices.listDevices(),
      messageStats()
    ])
    ok(res, {
      whatsapp: {
        instances: instances.length,
        connected: instances.filter((i) => i.status === 'connected').length
      },
      sms: { devices: smsDevices.length, online: smsDevices.filter((d) => d.online && d.enabled).length },
      last_24h: stats
    })
  })
)

// ---- messages -------------------------------------------------------------
router.post(
  '/messages',
  wrap(async (req, res) => {
    ok(res, await enqueueMessage(req.body, { apiKeyId: apiKeyId(req) }), 201)
  })
)

router.post(
  '/messages/bulk',
  wrap(async (req, res) => {
    const list = req.body?.messages
    if (!Array.isArray(list) || !list.length) throw badRequest('messages must be a non-empty array')
    if (list.length > 1000) throw badRequest('At most 1000 messages per request')
    const results = []
    for (const [index, item] of list.entries()) {
      try {
        results.push({
          index,
          success: true,
          data: await enqueueMessage({ ...req.body.defaults, ...item }, { apiKeyId: apiKeyId(req) })
        })
      } catch (err) {
        results.push({ index, success: false, error: { message: err.message, details: err.details } })
      }
    }
    ok(res, results, 201)
  })
)

router.post(
  '/whatsapp/send',
  wrap(async (req, res) => {
    ok(res, await enqueueMessage({ ...req.body, channel: 'whatsapp' }, { apiKeyId: apiKeyId(req) }), 201)
  })
)

router.post(
  '/sms/send',
  wrap(async (req, res) => {
    ok(res, await enqueueMessage({ ...req.body, channel: 'sms', type: 'text' }, { apiKeyId: apiKeyId(req) }), 201)
  })
)

router.get(
  '/messages',
  wrap(async (req, res) => ok(res, await listMessages(req.query)))
)
router.get(
  '/messages/:id',
  wrap(async (req, res) => ok(res, await getMessage(req.params.id)))
)
router.delete(
  '/messages/:id',
  wrap(async (req, res) => ok(res, await cancelMessage(req.params.id)))
)

// ---- OTP ------------------------------------------------------------------
router.post(
  '/otp/send',
  wrap(async (req, res) => {
    ok(
      res,
      await sendOtp(req.body, {
        apiKeyId: apiKeyId(req),
        ip: String(req.body?.ip ?? req.ip ?? '').slice(0, 64) || null
      }),
      201
    )
  })
)

router.post(
  '/otp/verify',
  wrap(async (req, res) => {
    const limit = otpVerifyLimiter(`${req.body?.phone ?? req.body?.otp_id ?? ''}`)
    if (!limit.ok) throw tooMany('Too many verification attempts', { retry_after: limit.retryAfterSec })
    ok(res, await verifyOtp(req.body))
  })
)

router.get(
  '/otp',
  wrap(async (req, res) => ok(res, await listOtps(req.query.limit)))
)
router.get(
  '/otp/:id',
  wrap(async (req, res) => ok(res, await getOtp(req.params.id)))
)

// ---- WhatsApp instances ---------------------------------------------------
const phonesSchema = z.object({
  phones: z
    .array(z.union([z.string(), z.number()]).transform(String))
    .min(1)
    .max(50)
})

router.post(
  '/whatsapp/check',
  wrap(async (req, res) => {
    const body = req.body?.phone ? { phones: [req.body.phone] } : req.body
    const parsed = phonesSchema.safeParse(body)
    if (!parsed.success) throw badRequest('phones must be an array of 1-50 numbers')
    ok(res, await wa.checkNumbers(parsed.data.phones, req.body.instance_id))
  })
)

router.get(
  '/instances',
  wrap(async (_req, res) => ok(res, await wa.listInstances()))
)
router.post(
  '/instances',
  wrap(async (req, res) => {
    ok(res, await wa.createInstance({ name: req.body?.name, connect: req.body?.connect !== false }), 201)
  })
)
router.get(
  '/instances/:id',
  wrap(async (req, res) => ok(res, await wa.getInstance(req.params.id)))
)
router.patch(
  '/instances/:id',
  wrap(async (req, res) => ok(res, await wa.updateInstance(req.params.id, req.body ?? {})))
)
router.delete(
  '/instances/:id',
  wrap(async (req, res) => {
    await wa.deleteInstance(req.params.id)
    ok(res, { deleted: true })
  })
)
router.get(
  '/instances/:id/qr',
  wrap(async (req, res) => ok(res, await wa.instanceQr(req.params.id)))
)
router.post(
  '/instances/:id/pairing-code',
  wrap(async (req, res) => {
    ok(res, await wa.pairingCode(req.params.id, req.body?.phone))
  })
)
router.post(
  '/instances/:id/connect',
  wrap(async (req, res) => ok(res, await wa.connectInstance(req.params.id)))
)
router.post(
  '/instances/:id/restart',
  wrap(async (req, res) => ok(res, await wa.restartInstance(req.params.id)))
)
router.post(
  '/instances/:id/logout',
  wrap(async (req, res) => ok(res, await wa.logoutInstance(req.params.id)))
)
router.get(
  '/instances/:id/groups',
  wrap(async (req, res) => ok(res, await wa.instanceGroups(req.params.id)))
)

// ---- SMS devices ----------------------------------------------------------
router.get(
  '/devices',
  wrap(async (_req, res) => ok(res, await devices.listDevices()))
)
router.post(
  '/devices',
  wrap(async (req, res) => ok(res, await devices.createDevice({ name: req.body?.name }), 201))
)
router.get(
  '/devices/:id',
  wrap(async (req, res) => ok(res, await devices.getDevice(req.params.id)))
)
router.patch(
  '/devices/:id',
  wrap(async (req, res) => ok(res, await devices.updateDevice(req.params.id, req.body ?? {})))
)
router.delete(
  '/devices/:id',
  wrap(async (req, res) => {
    await devices.deleteDevice(req.params.id)
    ok(res, { deleted: true })
  })
)
router.post(
  '/devices/:id/rotate-token',
  wrap(async (req, res) => ok(res, await devices.rotateDeviceToken(req.params.id)))
)

// ---- webhooks -------------------------------------------------------------
router.get(
  '/webhooks',
  wrap(async (_req, res) => ok(res, await webhooks.listWebhooks()))
)
router.post(
  '/webhooks',
  wrap(async (req, res) => ok(res, await webhooks.createWebhook(req.body), 201))
)
router.get(
  '/webhooks/:id',
  wrap(async (req, res) => ok(res, await webhooks.getWebhook(req.params.id)))
)
router.patch(
  '/webhooks/:id',
  wrap(async (req, res) => ok(res, await webhooks.updateWebhook(req.params.id, req.body)))
)
router.delete(
  '/webhooks/:id',
  wrap(async (req, res) => {
    await webhooks.deleteWebhook(req.params.id)
    ok(res, { deleted: true })
  })
)
router.post(
  '/webhooks/:id/test',
  wrap(async (req, res) => {
    await webhooks.sendTestEvent(req.params.id)
    ok(res, { queued: true })
  })
)
router.get(
  '/webhooks/:id/deliveries',
  wrap(async (req, res) => {
    ok(res, await webhooks.listDeliveries(req.params.id, req.query.limit))
  })
)
router.post(
  '/webhook-deliveries/:id/retry',
  wrap(async (req, res) => {
    await webhooks.retryDelivery(req.params.id)
    ok(res, { queued: true })
  })
)

// ---- API keys (dashboard only) --------------------------------------------
router.get(
  '/keys',
  requireAdmin,
  wrap(async (_req, res) => ok(res, await listApiKeys()))
)
router.post(
  '/keys',
  requireAdmin,
  wrap(async (req, res) => ok(res, await createApiKey(req.body?.name), 201))
)
router.delete(
  '/keys/:id',
  requireAdmin,
  wrap(async (req, res) => ok(res, { revoked: await revokeApiKey(req.params.id) }))
)

export default router
