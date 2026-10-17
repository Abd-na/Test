// Minimal Node.js client (Node 18+). Usage:
//   const vm = createVetaMessenger({ url: process.env.VETA_MESSENGER_URL, key: process.env.VETA_MESSENGER_KEY })
//   await vm.send('+9647701234567', 'مرحباً')
//   await vm.sendOtp('+9647701234567', 'login'); const ok = await vm.verifyOtp('+9647701234567', '123456', 'login')
import crypto from 'node:crypto'

export function createVetaMessenger({ url, key }) {
  const call = async (method, path, body) => {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    const json = await res.json()
    if (!json.success) throw Object.assign(new Error(json.error?.message ?? `HTTP ${res.status}`), { status: res.status, error: json.error })
    return json.data
  }
  return {
    send: (to, text, channel = 'auto', extra = {}) => call('POST', '/messages', { to, text, channel, ...extra }),
    sendOtp: (phone, purpose = 'login', channel = 'auto') => call('POST', '/otp/send', { phone, purpose, channel }),
    verifyOtp: async (phone, code, purpose = 'login') => (await call('POST', '/otp/verify', { phone, code, purpose })).valid,
    message: (id) => call('GET', `/messages/${id}`)
  }
}

/** Express example: app.post('/webhooks/messenger', express.raw({ type: 'application/json' }), handler) */
export function verifyWebhook(rawBody, headers, secret) {
  const ts = headers['x-veta-timestamp']
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`
  const given = String(headers['x-veta-signature'] ?? '')
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
