import { config } from '../config.js'
import { badRequest } from './errors.js'

const ARABIC_DIGITS = /[٠-٩۰-۹]/g
const toLatinDigits = (s) => s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))

/**
 * Normalizes a phone number to international digits without "+", e.g.
 * "+964 770 123 4567", "00964770...", "0770..." (with DEFAULT_COUNTRY_CODE=964)
 * all become "9647701234567". WhatsApp JIDs (containing "@") pass through.
 */
export function normalizePhone(input, countryCode = config.defaultCountryCode) {
  if (input === undefined || input === null || String(input).trim() === '') {
    throw badRequest('Phone number is required')
  }
  let s = toLatinDigits(String(input).trim())
  if (s.includes('@')) return s
  s = s.replace(/[^\d+]/g, '')
  if (s.startsWith('+')) s = s.slice(1)
  else if (s.startsWith('00')) s = s.slice(2)
  else if (countryCode && s.startsWith('0')) s = countryCode + s.replace(/^0+/, '')
  if (!/^\d{7,15}$/.test(s)) throw badRequest(`Invalid phone number: ${input}`)
  return s
}

export const isGroupJid = (s) => typeof s === 'string' && s.endsWith('@g.us')

export function toJid(phoneOrJid) {
  return phoneOrJid.includes('@') ? phoneOrJid : `${phoneOrJid}@s.whatsapp.net`
}
