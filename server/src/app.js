import path from 'node:path'
import express from 'express'
import { ZodError } from 'zod'
import { config } from './config.js'
import { HttpError } from './lib/errors.js'
import { logger } from './lib/logger.js'
import apiRoutes from './routes/api.js'
import deviceRoutes from './routes/device.js'
import adminRoutes from './routes/admin.js'
import mediaRoutes from './routes/media.js'
import hypersenderRoutes from './routes/hypersender.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', config.trustProxy)

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Referrer-Policy', 'no-referrer')
    next()
  })
  app.use(express.json({ limit: `${Math.ceil(config.media.maxBytes / 1048576) * 2}mb` }))

  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.use('/api/admin', adminRoutes)
  app.use('/api/v1', apiRoutes)
  app.use('/api/device/v1', deviceRoutes)
  app.use('/media', mediaRoutes)
  // drop-in replacement for app.hypersender.com (/api/whatsapp/v2, /api/sms/v1, /api/otp/v2)
  app.use('/api', hypersenderRoutes)
  app.use(express.static(path.join(config.root, 'public'), { index: 'index.html', maxAge: '1h' }))

  app.use('/api', (_req, res) => {
    res.status(404).json({ success: false, error: { code: 'not_found', message: 'Endpoint not found' } })
  })

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ZodError) err = new HttpError(400, 'bad_request', 'Invalid request', err.issues)
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'bad_json', 'Request body is not valid JSON')
    if (err.type === 'entity.too.large') err = new HttpError(413, 'too_large', 'Request body is too large')
    const status = err instanceof HttpError ? err.status : err.status && err.status < 500 ? err.status : 500
    if (status >= 500) logger.error({ err, path: req.path }, 'request failed')
    const body = {
      success: false,
      error: {
        code:
          err.code && typeof err.code === 'string' && status < 500
            ? err.code
            : status >= 500
              ? 'server_error'
              : 'error',
        message: status >= 500 ? 'Internal server error' : err.message
      }
    }
    if (err.details) body.error.details = err.details
    if (err.details?.retry_after) res.set('Retry-After', String(err.details.retry_after))
    res.status(status).json(body)
  })

  return app
}
