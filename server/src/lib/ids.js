import crypto from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function randomString(length) {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % 62]
  return out
}

/** Prefixed, URL-safe identifier such as `msg_3fK9...` */
export const newId = (prefix, length = 20) => `${prefix}_${randomString(length)}`
