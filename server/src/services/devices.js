import QRCode from 'qrcode'
import { config } from '../config.js'
import { exec, json, one, parseJson, query } from '../lib/db.js'
import { newId, randomString } from '../lib/ids.js'
import { sha256 } from '../lib/crypto.js'
import { bus, publish } from '../lib/events.js'
import { notFound } from '../lib/errors.js'
import { advanceStatus, failAttempt, getMessageRow, recordInbound } from './messages.js'
import { normalizePhone } from '../lib/phone.js'
import { logger } from '../lib/logger.js'

const onlineCutoff = () => new Date(Date.now() - config.sms.deviceOnlineSec * 1000)
const isOnline = (row) => Boolean(row.last_seen_at && row.last_seen_at >= onlineCutoff())

function presentDevice(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    online: isOnline(row),
    token_prefix: row.token_prefix,
    model: row.model,
    app_version: row.app_version,
    battery: row.battery,
    charging: row.charging === null ? null : Boolean(row.charging),
    signal: row.signal_level,
    sims: parseJson(row.sims, []),
    last_seen_at: row.last_seen_at,
    created_at: row.created_at
  }
}

async function pairingPayload(device, token) {
  const payload = JSON.stringify({ v: 1, url: config.publicUrl, token, name: device.name })
  return { token, pairing: payload, pairing_qr: await QRCode.toDataURL(payload, { margin: 1, width: 320 }) }
}

export async function createDevice({ name }) {
  const token = `vmd_${randomString(40)}`
  const now = new Date()
  const row = {
    id: newId('dev', 16),
    name: name || 'Android phone',
    token_hash: sha256(token),
    token_prefix: token.slice(0, 10),
    enabled: 1,
    created_at: now,
    updated_at: now
  }
  await exec('INSERT INTO vm_sms_devices SET ?', [row])
  return { ...presentDevice(row), ...(await pairingPayload(row, token)) }
}

export async function rotateDeviceToken(id) {
  const row = await getDeviceRow(id)
  const token = `vmd_${randomString(40)}`
  await exec('UPDATE vm_sms_devices SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ?', [
    sha256(token),
    token.slice(0, 10),
    new Date(),
    id
  ])
  return { ...presentDevice(row), ...(await pairingPayload(row, token)) }
}

async function getDeviceRow(id) {
  const row = await one('SELECT * FROM vm_sms_devices WHERE id = ?', [id])
  if (!row) throw notFound('Device')
  return row
}

export const getDevice = async (id) => presentDevice(await getDeviceRow(id))

export async function listDevices() {
  return (await query('SELECT * FROM vm_sms_devices ORDER BY created_at ASC')).map(presentDevice)
}

export async function updateDevice(id, { name, enabled }) {
  await getDeviceRow(id)
  const fields = { updated_at: new Date() }
  if (name) fields.name = name
  if (enabled !== undefined) fields.enabled = enabled ? 1 : 0
  await exec('UPDATE vm_sms_devices SET ? WHERE id = ?', [fields, id])
  return getDevice(id)
}

export async function deleteDevice(id) {
  await getDeviceRow(id)
  await exec('DELETE FROM vm_sms_devices WHERE id = ?', [id])
}

export async function authenticateDevice(token) {
  if (typeof token !== 'string' || !token.startsWith('vmd_')) return null
  return one('SELECT * FROM vm_sms_devices WHERE token_hash = ?', [sha256(token)])
}

export async function onlineDeviceCount() {
  const row = await one('SELECT COUNT(*) AS c FROM vm_sms_devices WHERE enabled = 1 AND last_seen_at >= ?', [
    onlineCutoff()
  ])
  return Number(row.c)
}

// --- device protocol -------------------------------------------------------

const knownOnline = new Set()

export async function touchDevice(device, info = {}) {
  const fields = { last_seen_at: new Date() }
  if (info.model) fields.model = String(info.model).slice(0, 120)
  if (info.app_version) fields.app_version = String(info.app_version).slice(0, 40)
  if (Number.isFinite(info.battery)) fields.battery = Math.max(0, Math.min(100, Math.round(info.battery)))
  if (typeof info.charging === 'boolean') fields.charging = info.charging ? 1 : 0
  if (Number.isFinite(info.signal)) fields.signal_level = Math.max(0, Math.min(4, Math.round(info.signal)))
  if (Array.isArray(info.sims)) fields.sims = json(info.sims.slice(0, 4))
  await exec('UPDATE vm_sms_devices SET ? WHERE id = ?', [fields, device.id])
  if (!knownOnline.has(device.id)) {
    knownOnline.add(device.id)
    publish('device.online', presentDevice({ ...device, ...fields }))
  }
}

/** Emits device.offline for phones that stopped polling. */
export async function sweepOfflineDevices() {
  if (!knownOnline.size) return
  const rows = await query('SELECT * FROM vm_sms_devices WHERE id IN (?)', [[...knownOnline]])
  for (const row of rows) {
    if (!isOnline(row)) {
      knownOnline.delete(row.id)
      publish('device.offline', presentDevice(row))
    }
  }
}

/** Atomically hands up to `limit` due SMS to this phone. */
export async function claimOutbox(device, limit) {
  if (!device.enabled) return []
  const token = randomString(24)
  const now = new Date()
  await exec(
    `UPDATE vm_messages
       SET status = 'sending', device_id = ?, claim_token = ?, locked_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE channel = 'sms' AND direction = 'out' AND status = 'queued' AND next_attempt_at <= ?
       AND (expires_at IS NULL OR expires_at > ?)
       AND (device_id IS NULL OR device_id = ?)
     ORDER BY priority DESC, next_attempt_at ASC
     LIMIT ?`,
    [device.id, token, now, now, now, now, device.id, limit]
  )
  const rows = await query('SELECT * FROM vm_messages WHERE claim_token = ?', [token])
  return rows.map((r) => ({ id: r.id, to: `+${r.phone}`, text: r.body, sim: r.sim }))
}

const waiters = new Set()
bus.on('sms:queued', () => {
  for (const wake of waiters) wake()
})

function waitForWork(ms) {
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      waiters.delete(wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    waiters.add(wake)
  })
}

/** Long-poll: returns as soon as work exists, or [] after `waitSec`. */
export async function pollOutbox(device, { waitSec = 25, limit = 5, signal } = {}) {
  const deadline = Date.now() + Math.min(Math.max(waitSec, 0), 55) * 1000
  for (;;) {
    const jobs = await claimOutbox(device, limit)
    if (jobs.length || Date.now() >= deadline || signal?.aborted) return jobs
    // re-check at least every 5s so scheduled messages become visible
    await waitForWork(Math.min(deadline - Date.now(), 5000))
    if (signal?.aborted) return []
  }
}

/** Status report from the phone: sent | delivered | failed. */
export async function reportStatus(device, { id, status, error }) {
  const row = await getMessageRow(id)
  if (!row || row.device_id !== device.id || row.channel !== 'sms') return false
  if (status === 'failed') {
    // radio/SIM errors are worth retrying (possibly on another phone)
    await failAttempt(id, error || 'SMS sending failed on device')
  } else if (status === 'sent' || status === 'delivered') {
    await advanceStatus(id, status, { claim_token: null })
  } else {
    return false
  }
  return true
}

export async function receiveSms(device, { from, text, received_at, sim }) {
  let phone
  try {
    phone = normalizePhone(from)
  } catch {
    phone = String(from).slice(0, 80) // alphanumeric sender IDs such as "Zain"
  }
  logger.info({ device: device.id, from: phone }, 'SMS received')
  return recordInbound({
    channel: 'sms',
    device_id: device.id,
    phone,
    type: 'text',
    body: text,
    sim: sim ?? null,
    received_at: received_at ? new Date(received_at) : new Date()
  })
}

export function deviceConfig() {
  return {
    min_delay_ms: config.sms.minDelayMs,
    poll_wait_sec: 25,
    heartbeat_sec: Math.max(Math.floor(config.sms.deviceOnlineSec / 3), 15)
  }
}
