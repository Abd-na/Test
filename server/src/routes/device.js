import { Router } from 'express'
import { z } from 'zod'
import { bearer } from '../middleware/auth.js'
import { badRequest, unauthorized } from '../lib/errors.js'
import * as devices from '../services/devices.js'

/**
 * API used by the Veta SMS Gateway Android app. The phone always connects
 * out to the server (long-polling), so it works behind NAT / mobile data.
 */
const router = Router()
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

router.use(
  wrap(async (req, _res, next) => {
    const device = await devices.authenticateDevice(bearer(req))
    if (!device) throw unauthorized('Invalid device token')
    req.device = device
    next()
  })
)

const heartbeatSchema = z
  .object({
    model: z.string().optional(),
    app_version: z.string().optional(),
    battery: z.number().optional(),
    charging: z.boolean().optional(),
    signal: z.number().optional(),
    sims: z
      .array(
        z.object({ slot: z.number(), carrier: z.string().optional(), number: z.string().optional() }).passthrough()
      )
      .optional()
  })
  .passthrough()

router.post(
  '/heartbeat',
  wrap(async (req, res) => {
    const info = heartbeatSchema.safeParse(req.body ?? {})
    await devices.touchDevice(req.device, info.success ? info.data : {})
    res.json({
      success: true,
      data: {
        device: { id: req.device.id, name: req.device.name, enabled: Boolean(req.device.enabled) },
        config: devices.deviceConfig()
      }
    })
  })
)

router.get(
  '/outbox',
  wrap(async (req, res) => {
    await devices.touchDevice(req.device)
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    const jobs = await devices.pollOutbox(req.device, {
      waitSec: Number(req.query.wait ?? 25),
      limit: Math.min(Math.max(Number(req.query.limit) || 5, 1), 20),
      signal: controller.signal
    })
    if (controller.signal.aborted && jobs.length) {
      // phone went away after we claimed: put them back for another attempt
      for (const job of jobs)
        await devices.reportStatus(req.device, {
          id: job.id,
          status: 'failed',
          error: 'Phone disconnected before receiving the SMS'
        })
      return
    }
    res.json({ success: true, data: jobs })
  })
)

const statusSchema = z.object({
  id: z.string(),
  status: z.enum(['sent', 'delivered', 'failed']),
  error: z.string().max(500).optional()
})

router.post(
  '/status',
  wrap(async (req, res) => {
    const list = Array.isArray(req.body?.updates) ? req.body.updates : [req.body]
    const results = []
    for (const item of list) {
      const parsed = statusSchema.safeParse(item)
      if (!parsed.success) throw badRequest('Invalid status update', parsed.error.issues)
      results.push({ id: parsed.data.id, accepted: await devices.reportStatus(req.device, parsed.data) })
    }
    res.json({ success: true, data: results })
  })
)

const inboxSchema = z.object({
  from: z.string().min(1).max(80),
  text: z.string().max(10000),
  received_at: z.union([z.string(), z.number()]).optional(),
  sim: z.number().int().min(1).max(4).optional()
})

router.post(
  '/inbox',
  wrap(async (req, res) => {
    const list = Array.isArray(req.body?.messages) ? req.body.messages : [req.body]
    const saved = []
    for (const item of list) {
      const parsed = inboxSchema.safeParse(item)
      if (!parsed.success) throw badRequest('Invalid incoming SMS', parsed.error.issues)
      saved.push((await devices.receiveSms(req.device, parsed.data)).id)
    }
    res.json({ success: true, data: { saved } })
  })
)

export default router
