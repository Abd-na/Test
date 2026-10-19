// Hypersender-compatible API, checked against the formats of the official
// hypersender/hypersender-laravel SDK. Needs MySQL (see integration.test.js).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const enabled = Boolean(process.env.TEST_DB_DATABASE)

// event names accepted by the SDK (src/Enums/*WebhookEventEnum.php)
const SDK_SMS_EVENTS = [
  'phone.heartbeat.received',
  'phone.heartbeat.online',
  'phone.heartbeat.offline',
  'phone.heartbeat.missed',
  'phone.heartbeat.disabled',
  'message.send.failed',
  'message.phone.delivered',
  'message.phone.received',
  'message.notification.scheduled',
  'message.phone.sent',
  'message.send.expired',
  'message.call.missed'
]
const SDK_WA_EVENTS = [
  'presence.update',
  'message.any',
  'message.reaction',
  'message.ack',
  'message.waiting',
  'message.revoked',
  'poll.vote',
  'poll.vote.failed'
]

describe('Hypersender-compatible API', { skip: !enabled && 'TEST_DB_DATABASE not set' }, () => {
  let base, server, key, stop, deviceToken, hookServer
  const received = []

  before(async () => {
    Object.assign(process.env, {
      DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
      DB_PORT: process.env.TEST_DB_PORT ?? '3306',
      DB_USERNAME: process.env.TEST_DB_USERNAME ?? 'root',
      DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
      DB_DATABASE: process.env.TEST_DB_DATABASE,
      APP_SECRET: 'hypersender_test_secret_hypersender_test_1',
      ADMIN_PASSWORD: 'admin-pass-123',
      DEFAULT_COUNTRY_CODE: '20',
      LOG_LEVEL: 'silent',
      OTP_RESEND_COOLDOWN_SEC: '0'
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
    key = (await (await import('../src/services/api-keys.js')).createApiKey('veta')).key
    hookServer = http
      .createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
          res.end('{"status":"ok"}')
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

  // exactly what the SDK sends: Bearer key, JSON, /{instance}/{action}
  const sdk = async (method, path, body, token = key) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'Hypersender Laravel SDK'
      },
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

  test('rejects a wrong API key in Hypersender style', async () => {
    const r = await sdk(
      'POST',
      '/api/whatsapp/v2/any-instance/send-text',
      { chatId: '201234567890@c.us', text: 'x' },
      'nope'
    )
    assert.equal(r.status, 401)
    assert.ok(r.json.message)
  })

  test('WhatsApp send without a connected instance answers 503', async () => {
    const r = await sdk('POST', '/api/whatsapp/v2/any-instance/send-text', { chatId: '201234567890@c.us', text: 'hi' })
    assert.equal(r.status, 503)
    assert.match(r.json.message, /WhatsApp/)
  })

  test('typing / seen endpoints are accepted', async () => {
    const r = await sdk('POST', '/api/whatsapp/v2/x/start-typing', { chatId: '201234567890@c.us' })
    assert.deepEqual([r.status, r.json], [200, { result: true }])
  })

  test('unsupported actions answer 501', async () => {
    const r = await sdk('POST', '/api/whatsapp/v2/x/send-poll', { chatId: '201234567890@c.us' })
    assert.equal(r.status, 501)
  })

  test('webhooks in Hypersender format with the plain Authorization secret', async () => {
    const port = hookServer.address().port
    const sms = await sdk('POST', '/api/v1/webhooks', {
      url: `http://127.0.0.1:${port}/sms/webhook`,
      format: 'hypersender',
      channel: 'sms',
      secret: 'x-sms-webhook'
    })
    assert.equal(sms.status, 201)
    assert.equal(sms.json.data.format, 'hypersender')
    const wa = await sdk('POST', '/api/v1/webhooks', {
      url: `http://127.0.0.1:${port}/whatsapp/webhook`,
      format: 'hypersender',
      channel: 'whatsapp',
      secret: 'wa-secret-123'
    })
    assert.equal(wa.status, 201)
    const dev = await sdk('POST', '/api/v1/devices', { name: 'Gateway' })
    deviceToken = dev.json.data.token
    await sdk('POST', '/api/device/v1/heartbeat', {}, deviceToken)
  })

  test('SMS send-message: same request and response shape as the SDK', async () => {
    const r = await sdk('POST', '/api/sms/v1/any-phone/send-message', {
      content: 'Hello, world!',
      request_id: 'req_abc',
      to: '+201098765432'
    })
    assert.equal(r.status, 200)
    for (const k of [
      'id',
      'request_id',
      'message_thread_id',
      'to_phone_number',
      'content',
      'status',
      'type',
      'created_at'
    ])
      assert.ok(k in r.json, k)
    assert.equal(r.json.request_id, 'req_abc')
    assert.equal(r.json.to_phone_number, '+201098765432')
    assert.equal(r.json.status, 'pending')
    assert.equal(r.json.type, 'sent_to_mobile')

    const jobs = await waitFor(async () => {
      const j = await sdk('GET', '/api/device/v1/outbox?wait=1', null, deviceToken)
      return j.json.data.length ? j.json.data : null
    })
    await sdk('POST', '/api/device/v1/status', { id: jobs[0].id, status: 'sent' }, deviceToken)
    await sdk('POST', '/api/device/v1/status', { id: jobs[0].id, status: 'delivered' }, deviceToken)
    await sdk('POST', '/api/device/v1/inbox', { from: '+201011112222', text: 'رد' }, deviceToken)

    const smsHooks = await waitFor(() => {
      const list = received.filter((h) => h.path === '/sms/webhook' && h.body.event.startsWith('message.'))
      return list.length >= 3 ? list : null
    })
    for (const h of smsHooks) {
      assert.equal(h.auth, 'x-sms-webhook')
      assert.ok(SDK_SMS_EVENTS.includes(h.body.event), h.body.event)
    }
    const delivered = smsHooks.find((h) => h.body.event === 'message.phone.delivered')
    assert.equal(delivered.body.data.request_id, 'req_abc')
    assert.equal(delivered.body.data.status, 'delivered')
    const inbound = smsHooks.find((h) => h.body.event === 'message.phone.received')
    assert.equal(inbound.body.data.from_phone_number, '+201011112222')
    assert.equal(inbound.body.data.content, 'رد')
    assert.equal(inbound.body.data.type, 'received_from_mobile')
    // heartbeat event from the phone coming online
    assert.ok(received.some((h) => h.body.event === 'phone.heartbeat.online'))
    // nothing in Veta format and nothing on the WhatsApp hook for SMS traffic
    assert.ok(!received.some((h) => h.path === '/whatsapp/webhook' && h.body.event !== 'presence.update'))
  })

  test('SMS messages list is paginated like Hypersender', async () => {
    const r = await sdk('GET', '/api/sms/v1/x/messages?per_page=1&page=1')
    assert.equal(r.status, 200)
    assert.equal(r.json.data.length, 1)
    assert.ok(r.json.meta.total >= 2)
    assert.ok(r.json.links.next)
  })

  test('OTP request-code / validate-code like the SDK (falls back to SMS without WhatsApp)', async () => {
    const req = await sdk('POST', '/api/otp/v2/x/request-code', {
      chatId: '201055556666@c.us',
      length: 6,
      useNumber: true,
      useLetter: false,
      allCapital: false,
      name: 'Veta',
      expires: 30
    })
    assert.equal(req.status, 200)
    assert.equal(req.json.success, true)
    assert.equal(req.json.data.chat_id, '201055556666@c.us')
    assert.match(req.json.data.code, /^\d{6}$/)
    assert.equal(req.json.data.status, 'pending')
    assert.equal(req.json.data.otp_type, 'code')
    const minutes = (new Date(req.json.data.expires_at) - new Date(req.json.data.created_at)) / 60000
    assert.ok(Math.abs(minutes - 30) < 0.1, `expiry ${minutes} min`)

    const bad = await sdk('POST', '/api/otp/v2/x/validate-code', {
      chatId: '201055556666@c.us',
      code: '000000' === req.json.data.code ? '111111' : '000000'
    })
    assert.equal(bad.status, 422)
    assert.equal(bad.json.success, false)

    const ok = await sdk('POST', '/api/otp/v2/x/validate-code', {
      chatId: '201055556666@c.us',
      code: req.json.data.code
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.data.status, 'validated')
    assert.equal(ok.json.data.uuid, req.json.data.uuid)
  })

  test('OTP with letters', async () => {
    const r = await sdk('POST', '/api/otp/v2/x/request-code', {
      chatId: '201077778888@c.us',
      length: 8,
      useNumber: true,
      useLetter: true,
      allCapital: true,
      name: 'Veta',
      expires: 600
    })
    assert.match(r.json.data.code, /^[2-9A-Z]{8}$/)
    const minutes = (new Date(r.json.data.expires_at) - new Date(r.json.data.created_at)) / 60000
    assert.ok(Math.abs(minutes - 10) < 0.1) // 600 → seconds
  })

  test('test event on a Hypersender webhook is a valid SDK event', async () => {
    const hooks = await sdk('GET', '/api/v1/webhooks')
    const wa = hooks.json.data.find((h) => h.channel === 'whatsapp')
    await sdk('POST', `/api/v1/webhooks/${wa.id}/test`)
    const got = await waitFor(() => received.find((h) => h.path === '/whatsapp/webhook'))
    assert.ok(SDK_WA_EVENTS.includes(got.body.event))
    assert.equal(got.auth, 'wa-secret-123')
  })
})
