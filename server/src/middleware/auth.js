import { findApiKey } from '../services/api-keys.js'
import { verifyToken } from '../lib/crypto.js'
import { HttpError, unauthorized } from '../lib/errors.js'

function bearer(req) {
  const header = req.get('authorization') || ''
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return req.get('x-api-key') || null
}

/** Accepts either an API key (Veta app) or an admin dashboard session. */
export async function requireAuth(req, _res, next) {
  try {
    const token = bearer(req)
    if (!token) throw unauthorized('Missing API key. Send "Authorization: Bearer <key>"')
    const session = verifyToken(token)
    if (session?.role === 'admin') {
      req.auth = { type: 'admin' }
      return next()
    }
    const key = await findApiKey(token)
    if (!key) throw unauthorized('Invalid or revoked API key')
    req.auth = { type: 'api_key', apiKey: key }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireAdmin(req, _res, next) {
  if (req.auth?.type !== 'admin') return next(new HttpError(403, 'forbidden', 'Admin session required'))
  next()
}

export { bearer }
