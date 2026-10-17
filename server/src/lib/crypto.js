import crypto from 'node:crypto'
import { config } from '../config.js'

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

export const hmac = (value, secret = config.appSecret) =>
  crypto.createHmac('sha256', secret).update(value).digest('hex')

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

/** Short-lived signed token: base64url(json).signature */
export function signToken(payload, ttlSec) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSec * 1000 })).toString('base64url')
  return `${body}.${hmac(`token:${body}`)}`
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!safeEqual(sig, hmac(`token:${body}`))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    return payload.exp > Date.now() ? payload : null
  } catch {
    return null
  }
}

export const signMediaPath = (file) => hmac(`media:${file}`).slice(0, 32)
