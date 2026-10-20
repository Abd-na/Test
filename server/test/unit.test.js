import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.APP_SECRET ??= 'unit_test_secret_unit_test_secret_123'
const { normalizePhone } = await import('../src/lib/phone.js')
const { signToken, verifyToken, hmac } = await import('../src/lib/crypto.js')
const { signPayload } = await import('../src/services/webhooks.js')
const { smsPhoneObject } = await import('../src/services/hypersender.js')

test('normalizePhone handles international, 00, local and Arabic digits', () => {
  assert.equal(normalizePhone('+964 770 123 4567', ''), '9647701234567')
  assert.equal(normalizePhone('00964-770-123-4567', ''), '9647701234567')
  assert.equal(normalizePhone('07701234567', '964'), '9647701234567')
  assert.equal(normalizePhone('٠٧٧٠١٢٣٤٥٦٧', '964'), '9647701234567')
  assert.equal(normalizePhone('۰۷۷۰۱۲۳۴۵۶۷', '964'), '9647701234567')
  assert.equal(normalizePhone('120363000000@g.us', ''), '120363000000@g.us')
  assert.throws(() => normalizePhone('12', ''), /Invalid phone/)
  assert.throws(() => normalizePhone('', ''), /required/)
})

test('signed tokens verify and reject tampering', () => {
  const token = signToken({ role: 'admin' }, 60)
  assert.equal(verifyToken(token).role, 'admin')
  const [body, sig] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + 1e9 })).toString('base64url')
  assert.equal(verifyToken(`${forged}.${sig}`), null)
  assert.equal(verifyToken(`${body}.${'0'.repeat(64)}`), null)
  assert.equal(verifyToken(signToken({ role: 'admin' }, -1)), null)
})

test('webhook signature is HMAC-SHA256 of "timestamp.body"', () => {
  const body = '{"event":"message.received"}'
  assert.equal(signPayload('whsec_x', '1700000000', body), `sha256=${hmac(`1700000000.${body}`, 'whsec_x')}`)
})

test('Hypersender phone object reports the SIM a device is paired to', () => {
  const base = { id: 'dev_1', name: 'Samsung', last_seen_at: new Date(), created_at: new Date() }
  assert.equal(smsPhoneObject({ ...base, sims: '[{"slot":2,"carrier":"Asiacell"}]' }).sim, 'SIM2')
  assert.equal(smsPhoneObject({ ...base, sims: [{ slot: 1 }] }).sim, 'SIM1')
  // older app versions report every SIM of the phone
  assert.equal(smsPhoneObject({ ...base, sims: '[{"slot":1},{"slot":2}]' }).sim, 'SIM1')
  assert.equal(smsPhoneObject({ ...base, sims: null }).sim, 'SIM1')
})
