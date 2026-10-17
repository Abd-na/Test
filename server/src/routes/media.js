import { Router } from 'express'
import { absolutePath } from '../services/media.js'
import { safeEqual, signMediaPath } from '../lib/crypto.js'

/** Serves stored media (e.g. incoming WhatsApp images) behind an HMAC signature. */
const router = Router()

router.get(/^\/((?:in|out)\/[\w.-]+)$/, (req, res) => {
  const file = req.params[0]
  if (!safeEqual(String(req.query.sig ?? ''), signMediaPath(file))) return res.status(403).end()
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox")
  res.sendFile(absolutePath(file), { maxAge: '7d', dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).end()
  })
})

export default router
