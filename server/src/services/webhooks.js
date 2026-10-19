import { z } from 'zod'
import { exec, one, parseJson, query } from '../lib/db.js'
import { newId, randomString } from '../lib/ids.js'
import { hmac } from '../lib/crypto.js'
import { bus, EVENTS } from '../lib/events.js'
import { badRequest, notFound } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { eventChannel, hypersenderTestEvent, toHypersenderWebhook } from './hypersender.js'

/**
 * Outgoing webhooks. Every delivery is persisted first and then sent by a
 * worker with exponential backoff, so events survive restarts and outages
 * of the receiving app.
 *
 * Signature: X-Veta-Signature = "sha256=" + HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
 */

const BACKOFF_SEC = [10, 30, 120, 600, 1800, 3600, 3 * 3600]
const MAX_ATTEMPTS = BACKOFF_SEC.length + 1
const TIMEOUT_MS = 10_000

export const webhookSchema = z.object({
  url: z.string().url().max(500),
  events: z
    .array(z.enum(['*', ...EVENTS]))
    .min(1)
    .default(['*']),
  description: z.string().max(255).optional(),
  instance_id: z.string().max(40).nullable().optional(),
  enabled: z.boolean().optional(),
  // "hypersender": Hypersender payloads + plain "Authorization: <secret>" header (drop-in for its SDK)
  format: z.enum(['veta', 'hypersender']).default('veta'),
  channel: z.enum(['whatsapp', 'sms']).nullable().optional(),
  // custom secret, e.g. the HYPERSENDER_*_WEBHOOK_AUTHORIZATION_SECRET already configured in the app
  secret: z.string().min(8).max(100).optional()
})

function present(row, { withSecret = false } = {}) {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: parseJson(row.events, []),
    instance_id: row.instance_id,
    enabled: Boolean(row.enabled),
    format: row.format ?? 'veta',
    channel: row.channel ?? null,
    ...(withSecret ? { secret: row.secret } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export async function createWebhook(body) {
  const parsed = webhookSchema.safeParse(body)
  if (!parsed.success) throw badRequest('Invalid webhook', parsed.error.issues)
  const now = new Date()
  const row = {
    id: newId('wh', 16),
    url: parsed.data.url,
    description: parsed.data.description ?? null,
    events: JSON.stringify(parsed.data.events),
    secret: parsed.data.secret ?? `whsec_${randomString(32)}`,
    instance_id: parsed.data.instance_id ?? null,
    enabled: parsed.data.enabled === false ? 0 : 1,
    format: parsed.data.format,
    channel: parsed.data.channel ?? null,
    created_at: now,
    updated_at: now
  }
  await exec('INSERT INTO vm_webhooks SET ?', [row])
  return present(row, { withSecret: true })
}

async function getRow(id) {
  const row = await one('SELECT * FROM vm_webhooks WHERE id = ?', [id])
  if (!row) throw notFound('Webhook')
  return row
}

export const getWebhook = async (id) => present(await getRow(id), { withSecret: true })

export async function listWebhooks() {
  return (await query('SELECT * FROM vm_webhooks ORDER BY created_at ASC')).map((r) => present(r, { withSecret: true }))
}

export async function updateWebhook(id, body) {
  await getRow(id)
  const parsed = webhookSchema.partial().safeParse({ format: undefined, ...body })
  if (!parsed.success) throw badRequest('Invalid webhook', parsed.error.issues)
  const d = parsed.data
  const fields = { updated_at: new Date() }
  if (d.url) fields.url = d.url
  if (d.events) fields.events = JSON.stringify(d.events)
  if (d.description !== undefined) fields.description = d.description
  if (d.instance_id !== undefined) fields.instance_id = d.instance_id
  if (d.enabled !== undefined) fields.enabled = d.enabled ? 1 : 0
  if (body?.format !== undefined) fields.format = d.format
  if (d.channel !== undefined) fields.channel = d.channel
  if (d.secret) fields.secret = d.secret
  if (body?.rotate_secret) fields.secret = `whsec_${randomString(32)}`
  await exec('UPDATE vm_webhooks SET ? WHERE id = ?', [fields, id])
  return getWebhook(id)
}

export async function deleteWebhook(id) {
  await getRow(id)
  await exec('DELETE FROM vm_webhook_deliveries WHERE webhook_id = ?', [id])
  await exec('DELETE FROM vm_webhooks WHERE id = ?', [id])
}

export async function listDeliveries(webhookId, limit = 50) {
  const rows = await query(
    'SELECT * FROM vm_webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?',
    [webhookId, Math.min(Number(limit) || 50, 200)]
  )
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    status: r.status,
    attempts: r.attempts,
    response_status: r.response_status,
    response_body: r.response_body,
    error: r.error,
    payload: parseJson(r.payload),
    next_attempt_at: r.next_attempt_at,
    delivered_at: r.delivered_at,
    created_at: r.created_at
  }))
}

export async function retryDelivery(id) {
  const res = await exec(
    "UPDATE vm_webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?",
    [new Date(), new Date(), id]
  )
  if (!res.affectedRows) throw notFound('Delivery')
  schedule(10)
}

const matches = (hook, event, data) => {
  const events = parseJson(hook.events, [])
  if (!events.includes('*') && !events.includes(event)) return false
  if (hook.instance_id && data?.instance_id && hook.instance_id !== data.instance_id) return false
  if (hook.channel && eventChannel(event, data) !== hook.channel) return false
  return true
}

async function enqueue(event, data, onlyWebhookId = null) {
  const hooks = onlyWebhookId
    ? await query('SELECT * FROM vm_webhooks WHERE id = ?', [onlyWebhookId])
    : await query('SELECT * FROM vm_webhooks WHERE enabled = 1')
  const now = new Date()
  const targets = onlyWebhookId ? hooks : hooks.filter((h) => matches(h, event, data))
  let queued = 0
  for (const hook of targets) {
    const id = newId('evt')
    let payload = { id, event, created_at: now.toISOString(), data }
    let eventName = event
    if (hook.format === 'hypersender') {
      payload = event === 'webhook.test' ? hypersenderTestEvent(hook.channel) : await toHypersenderWebhook(event, data)
      if (!payload) continue // no Hypersender equivalent (e.g. otp.verified)
      eventName = payload.event
    }
    queued++
    await exec('INSERT INTO vm_webhook_deliveries SET ?', [
      {
        id,
        webhook_id: hook.id,
        event: eventName,
        payload: JSON.stringify(payload),
        status: 'pending',
        next_attempt_at: now,
        created_at: now,
        updated_at: now
      }
    ])
  }
  if (queued) schedule(10)
  return queued
}

export async function sendTestEvent(webhookId) {
  await getRow(webhookId)
  await enqueue('webhook.test', { message: 'Hello from Veta Messenger' }, webhookId)
}

export function signPayload(secret, timestamp, body) {
  return `sha256=${hmac(`${timestamp}.${body}`, secret)}`
}

async function deliver(delivery) {
  const hook = await one('SELECT * FROM vm_webhooks WHERE id = ?', [delivery.webhook_id])
  if (!hook) {
    await exec("UPDATE vm_webhook_deliveries SET status = 'failed', error = 'webhook deleted' WHERE id = ?", [
      delivery.id
    ])
    return
  }
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const attempts = delivery.attempts + 1
  let status = null
  let responseBody = null
  let error = null
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'VetaMessenger-Webhook/1.0',
        'x-veta-event': delivery.event,
        'x-veta-delivery': delivery.id,
        'x-veta-timestamp': timestamp,
        'x-veta-signature': signPayload(hook.secret, timestamp, delivery.payload),
        // Hypersender's SDK compares this header with its configured authorization secret
        ...(hook.format === 'hypersender' ? { authorization: hook.secret } : {})
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual'
    })
    status = res.status
    responseBody = (await res.text().catch(() => '')).slice(0, 2000)
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (err) {
    error = (err.cause?.message || err.message || 'request failed').slice(0, 500)
  }

  const now = new Date()
  const fields = { attempts, response_status: status, response_body: responseBody, error, updated_at: now }
  if (!error) {
    Object.assign(fields, { status: 'success', delivered_at: now, next_attempt_at: null })
  } else if (attempts >= MAX_ATTEMPTS) {
    Object.assign(fields, { status: 'failed', next_attempt_at: null })
    logger.warn({ delivery: delivery.id, url: hook.url, error }, 'webhook delivery permanently failed')
  } else {
    Object.assign(fields, {
      status: 'pending',
      next_attempt_at: new Date(now.getTime() + BACKOFF_SEC[attempts - 1] * 1000)
    })
  }
  await exec('UPDATE vm_webhook_deliveries SET ? WHERE id = ?', [fields, delivery.id])
}

let timer = null
let running = false
let stopped = false

async function tick() {
  if (running || stopped) return
  running = true
  try {
    const due = await query(
      "SELECT * FROM vm_webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 20",
      [new Date()]
    )
    const claimed = []
    for (const d of due) {
      const res = await exec(
        "UPDATE vm_webhook_deliveries SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'",
        [new Date(), d.id]
      )
      if (res.affectedRows) claimed.push(d)
    }
    await Promise.all(claimed.map((d) => deliver(d).catch((err) => logger.error({ err }, 'webhook deliver crashed'))))
  } catch (err) {
    logger.error({ err }, 'webhook worker tick failed')
  } finally {
    running = false
    schedule(2000)
  }
}

function schedule(ms) {
  if (stopped) return
  clearTimeout(timer)
  timer = setTimeout(tick, ms)
}

export async function startWebhookWorker() {
  stopped = false
  // deliveries interrupted by a crash
  await exec("UPDATE vm_webhook_deliveries SET status = 'pending' WHERE status = 'processing'")
  bus.on('event', ({ event, data }) => {
    enqueue(event, data).catch((err) => logger.error({ err, event }, 'could not enqueue webhook'))
  })
  schedule(500)
}

export function stopWebhookWorker() {
  stopped = true
  clearTimeout(timer)
}
