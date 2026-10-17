// End-to-end tests against a real MySQL/MariaDB. Skipped unless TEST_DB_DATABASE is set, e.g.
// TEST_DB_HOST=127.0.0.1 TEST_DB_USERNAME=veta TEST_DB_PASSWORD=secret TEST_DB_DATABASE=veta_test npm test
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'

const enabled = Boolean(process.env.TEST_DB_DATABASE)

describe('API (MySQL)', { skip: !enabled && 'TEST_DB_DATABASE not set' }, () => {
  let base, server, key, deviceToken, stop
  const hooks = []
  let hookServer

  before(async () => {
    Object.assign(process.env, {
      DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
      DB_PORT: process.env.TEST_DB_PORT ?? '3306',
      DB_USERNAME: process.env.TEST_DB_USERNAME ?? 'root',
      DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
      DB_DATABASE: process.env.TEST_DB_DATABASE,
      APP_SECRET: 'integration_secret_integration_secret_1',
      ADMIN_PASSWORD: 'admin-pass-123',
      DEFAULT_COUNTRY_CODE: '964',
      LOG_LEVEL: 'silent',
      OTP_RESEND_COOLDOWN_SEC: '60'
    })
    const db = await import('../src/lib/db.js')
    for (const t of [
      'vm_api_keys',
      'vm_instances',
      'vm_wa_auth',
      'vm_sms_devices',
      'vm_messages',
      'vm_otps',
      'vm_webhooks',
      'vm_webhook_deliveries',
      'vm_migrations'
    ]) {
      await db.exec(`DROP TABLE IF EXISTS ${t}`)
    }
    await db.migrate()
    const { createApp } = await import('../src/app.js')
    const webhooks = await import('../src/services/webhooks.js')
    const dispatcher = await import('../src/services/dispatcher.js')
    await webhooks.startWebhookWorker()
    await dispatcher.startDispatcher()
    server = createApp().listen(0)
    base = `http://127.0.0.1:${server.address().port}`
    key = (await (await import('../src/services/api-keys.js')).createApiKey('test')).key

    hookServer = http
      .createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          hooks.push({ headers: req.headers, body })
          res.end('ok')
        })
      })
      .listen(0)

    stop = async () => {
      dispatcher.stopDispatcher()
      webhooks.stopWebhookWorker()
      server.close()
      server.closeAllConnections()
      hookServer.close()
      await db.pool.end()
    }
  })

  after(async () => stop?.())

  const call = async (path, { method = 'GET', body, token = key } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, json: await res.json() }
  }

  const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  test('rejects missing and invalid keys', async () => {
    assert.equal((await call('/api/v1/status', { token: '' })).status, 401)
    assert.equal((await call('/api/v1/status', { token: 'vk_live_wrong' })).status, 401)
    assert.equal((await call('/api/v1/status')).status, 200)
  })

  test('API keys can only be managed from the dashboard', async () => {
    assert.equal((await call('/api/v1/keys')).status, 403)
    const login = await call('/api/admin/login', { method: 'POST', body: { password: 'admin-pass-123' }, token: '' })
    assert.equal((await call('/api/v1/keys', { token: login.json.data.token })).status, 200)
    assert.equal(
      (await call('/api/admin/login', { method: 'POST', body: { password: 'nope' }, token: '' })).status,
      401
    )
  })

  test('registers a webhook and an SMS phone', async () => {
    const hook = await call('/api/v1/webhooks', {
      method: 'POST',
      body: { url: `http://127.0.0.1:${hookServer.address().port}/hook`, events: ['*'] }
    })
    assert.equal(hook.status, 201)
    assert.match(hook.json.data.secret, /^whsec_/)
    const dev = await call('/api/v1/devices', { method: 'POST', body: { name: 'Test phone' } })
    assert.equal(dev.status, 201)
    deviceToken = dev.json.data.token
    assert.match(deviceToken, /^vmd_/)
    const hb = await call('/api/device/v1/heartbeat', { method: 'POST', body: { battery: 90 }, token: deviceToken })
    assert.equal(hb.json.data.device.enabled, true)
  })

  test('OTP over auto channel falls back to SMS and verifies once', async () => {
    const sent = await call('/api/v1/otp/send', { method: 'POST', body: { phone: '07701112233', purpose: 'login' } })
    assert.equal(sent.status, 201)
    assert.equal(sent.json.data.phone, '9647701112233')
    assert.equal(sent.json.data.channel, 'whatsapp')

    const again = await call('/api/v1/otp/send', { method: 'POST', body: { phone: '07701112233', purpose: 'login' } })
    assert.equal(again.status, 429)

    // no WhatsApp is connected, so the dispatcher hands it to the SMS phone
    const jobs = await waitFor(async () => {
      const r = await call('/api/device/v1/outbox?wait=1', { token: deviceToken })
      return r.json.data.length ? r.json.data : null
    })
    assert.equal(jobs[0].to, '+9647701112233')
    const code = /(\d{6})/.exec(jobs[0].text)[1]

    const st = await call('/api/device/v1/status', {
      method: 'POST',
      body: { id: jobs[0].id, status: 'sent' },
      token: deviceToken
    })
    assert.equal(st.json.data[0].accepted, true)

    const wrong = await call('/api/v1/otp/verify', {
      method: 'POST',
      body: { phone: '+9647701112233', purpose: 'login', code: code === '000000' ? '111111' : '000000' }
    })
    assert.deepEqual(
      [wrong.json.data.valid, wrong.json.data.reason, wrong.json.data.attempts_left],
      [false, 'invalid_code', 4]
    )

    const ok = await call('/api/v1/otp/verify', {
      method: 'POST',
      body: { phone: '07701112233', purpose: 'login', code }
    })
    assert.equal(ok.json.data.valid, true)
    const reuse = await call('/api/v1/otp/verify', {
      method: 'POST',
      body: { phone: '07701112233', purpose: 'login', code }
    })
    assert.equal(reuse.json.data.reason, 'already_used')

    const msgs = await call('/api/v1/messages?phone=9647701112233')
    const wa = msgs.json.data.find((m) => m.channel === 'whatsapp')
    const sms = msgs.json.data.find((m) => m.channel === 'sms')
    assert.equal(wa.status, 'failed')
    assert.equal(wa.fallback_id, sms.id)
    assert.equal(sms.status, 'sent')
    assert.ok(!sms.text.includes(code), 'OTP code must be masked in the API')
  })

  test('OTP locks after too many wrong codes', async () => {
    await call('/api/v1/otp/send', {
      method: 'POST',
      body: { phone: '+9647709990000', channel: 'sms', purpose: 'reset' }
    })
    let last
    for (let i = 0; i < 6; i++) {
      last = await call('/api/v1/otp/verify', {
        method: 'POST',
        body: { phone: '+9647709990000', purpose: 'reset', code: 'x' }
      })
    }
    assert.equal(last.json.data.reason, 'too_many_attempts')
  })

  test('failed SMS is retried, incoming SMS is stored', async () => {
    const m = await call('/api/v1/sms/send', { method: 'POST', body: { to: '+9647705550000', text: 'hello' } })
    assert.equal(m.status, 201)
    const jobs = await call('/api/device/v1/outbox?wait=1&limit=20', { token: deviceToken })
    const job = jobs.json.data.find((j) => j.id === m.json.data.id)
    assert.ok(job)
    await call('/api/device/v1/status', {
      method: 'POST',
      body: { id: job.id, status: 'failed', error: 'no service' },
      token: deviceToken
    })
    const after = await call(`/api/v1/messages/${job.id}`)
    assert.equal(after.json.data.status, 'queued')
    assert.equal(after.json.data.error, 'no service')

    const inbox = await call('/api/device/v1/inbox', {
      method: 'POST',
      body: { from: '+9647701234567', text: 'رد من العميل' },
      token: deviceToken
    })
    assert.equal(inbox.status, 200)
    const received = await call('/api/v1/messages?direction=inbound&channel=sms')
    assert.equal(received.json.data[0].text, 'رد من العميل')
    assert.equal(received.json.data[0].from, '9647701234567')
  })

  test('validates messages', async () => {
    assert.equal((await call('/api/v1/messages', { method: 'POST', body: { to: '+9647701234567' } })).status, 400)
    assert.equal(
      (
        await call('/api/v1/messages', {
          method: 'POST',
          body: { to: '+9647701234567', channel: 'sms', type: 'image', media_url: 'https://x.y/a.png' }
        })
      ).status,
      400
    )
    assert.equal((await call('/api/v1/messages', { method: 'POST', body: { to: 'abc', text: 'x' } })).status, 400)
    const scheduled = await call('/api/v1/messages', {
      method: 'POST',
      body: {
        to: '+9647701234567',
        channel: 'sms',
        text: 'later',
        scheduled_at: new Date(Date.now() + 3600e3).toISOString()
      }
    })
    assert.ok(scheduled.json.data.scheduled_at)
    const cancelled = await call(`/api/v1/messages/${scheduled.json.data.id}`, { method: 'DELETE' })
    assert.equal(cancelled.json.data.status, 'cancelled')
  })

  test('webhooks are delivered with a valid signature', async () => {
    const { json } = await call('/api/v1/webhooks')
    const secret = json.data[0].secret
    const received = await waitFor(() => hooks.find((h) => h.headers['x-veta-event'] === 'message.received'))
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${received.headers['x-veta-timestamp']}.${received.body}`).digest('hex')}`
    assert.equal(received.headers['x-veta-signature'], expected)
    assert.ok(hooks.some((h) => h.headers['x-veta-event'] === 'otp.verified'))
    assert.ok(hooks.some((h) => h.headers['x-veta-event'] === 'message.failed'))
  })
})
