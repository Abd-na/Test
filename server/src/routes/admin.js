import { Router } from 'express'
import { config } from '../config.js'
import { safeEqual, sha256, signToken } from '../lib/crypto.js'
import { createLimiter } from '../lib/rate-limit.js'
import { tooMany, unauthorized } from '../lib/errors.js'

const router = Router()
const loginLimiter = createLimiter({ windowMs: 15 * 60_000, max: 10 })

router.post('/login', (req, res, next) => {
  const limit = loginLimiter(req.ip)
  if (!limit.ok) return next(tooMany('Too many login attempts', { retry_after: limit.retryAfterSec }))
  const password = String(req.body?.password ?? '')
  if (!safeEqual(sha256(password), sha256(config.adminPassword))) return next(unauthorized('Wrong password'))
  res.json({ success: true, data: { token: signToken({ role: 'admin' }, 12 * 3600), expires_in: 12 * 3600 } })
})

export default router
