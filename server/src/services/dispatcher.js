import { config } from '../config.js'
import { exec, parseJson, query } from '../lib/db.js'
import { bus } from '../lib/events.js'
import { logger } from '../lib/logger.js'
import { advanceStatus, failAttempt } from './messages.js'
import { connectedSessions, session as getSession } from './whatsapp/manager.js'
import { onlineDeviceCount, sweepOfflineDevices } from './devices.js'

/**
 * Sends queued WhatsApp messages one at a time per instance with a random
 * human-like delay between them (reduces the risk of WhatsApp bans), and
 * keeps the SMS queue healthy (timeouts, fallbacks). SMS themselves are
 * pulled by the Android phones through the device API.
 */

const lanes = new Map() // instanceId -> { busy, nextAt }
let timer = null
let running = false
let stopped = false
let lastHousekeeping = 0

const lane = (id) => {
  if (!lanes.has(id)) lanes.set(id, { busy: false, nextAt: 0 })
  return lanes.get(id)
}

const humanDelay = () => {
  const { minDelayMs, maxDelayMs } = config.whatsapp
  return minDelayMs + Math.random() * Math.max(maxDelayMs - minDelayMs, 0)
}

function pickSession(row) {
  if (row.instance_id) {
    try {
      const s = getSession(row.instance_id)
      return s.connected ? s : null
    } catch {
      return null
    }
  }
  const candidates = connectedSessions()
  const now = Date.now()
  return candidates.find((s) => !lane(s.id).busy && lane(s.id).nextAt <= now) ?? candidates[0] ?? null
}

async function claim(row, instanceId) {
  const res = await exec(
    `UPDATE vm_messages SET status = 'sending', instance_id = ?, locked_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'queued'`,
    [instanceId, new Date(), new Date(), row.id]
  )
  return res.affectedRows === 1
}

async function sendWhatsApp(row, s) {
  const l = lane(s.id)
  l.busy = true
  try {
    const providerId = await s.send(row, parseJson(row.extra, {}))
    await exec('UPDATE vm_messages SET provider_id = ? WHERE id = ?', [providerId, row.id])
    await advanceStatus(row.id, 'sent', { provider_id: providerId })
  } catch (err) {
    logger.warn({ id: row.id, err: err.message }, 'WhatsApp send failed')
    await failAttempt(row.id, err, { permanent: Boolean(err.permanent) })
  } finally {
    l.busy = false
    l.nextAt = Date.now() + humanDelay()
    schedule(50)
  }
}

async function processWhatsApp() {
  const now = new Date()
  const rows = await query(
    `SELECT * FROM vm_messages
     WHERE status = 'queued' AND channel = 'whatsapp' AND direction = 'out' AND next_attempt_at <= ?
     ORDER BY priority DESC, next_attempt_at ASC LIMIT 100`,
    [now]
  )
  const queueTimeout = config.sms.queueTimeoutSec * 1000
  for (const row of rows) {
    if (row.expires_at && row.expires_at <= now) {
      await failAttempt(row.id, 'Message expired before it could be sent', { permanent: true })
      continue
    }
    const s = pickSession(row)
    if (!s) {
      // no WhatsApp available: fall back right away, or give up after the queue timeout
      if (row.fallback_channel) await failAttempt(row.id, 'No connected WhatsApp instance', { permanent: true })
      else if (now - row.created_at > queueTimeout) {
        await failAttempt(row.id, 'No connected WhatsApp instance', { permanent: true })
      }
      continue
    }
    const l = lane(s.id)
    if (l.busy || l.nextAt > Date.now()) continue
    if (!(await claim(row, s.id))) continue
    sendWhatsApp({ ...row, instance_id: s.id, attempts: row.attempts + 1 }, s)
  }
}

async function housekeeping() {
  const now = new Date()
  // phones that claimed an SMS but never reported back
  const stuck = await query(
    "SELECT id FROM vm_messages WHERE channel = 'sms' AND status = 'sending' AND locked_at < ? LIMIT 100",
    [new Date(now - config.sms.sendTimeoutSec * 1000)]
  )
  for (const { id } of stuck) await failAttempt(id, 'Phone did not report the SMS result in time')

  // queued SMS that cannot go out
  const queued = await query(
    `SELECT id, fallback_channel, created_at, expires_at FROM vm_messages
     WHERE channel = 'sms' AND status = 'queued' AND direction = 'out' AND next_attempt_at <= ? LIMIT 200`,
    [now]
  )
  if (queued.length) {
    const online = await onlineDeviceCount()
    for (const row of queued) {
      if (row.expires_at && row.expires_at <= now) {
        await failAttempt(row.id, 'Message expired before it could be sent', { permanent: true })
      } else if (!online && row.fallback_channel) {
        await failAttempt(row.id, 'No SMS phone online', { permanent: true })
      } else if (now - row.created_at > config.sms.queueTimeoutSec * 1000) {
        await failAttempt(row.id, online ? 'SMS queue timeout' : 'No SMS phone online', { permanent: true })
      }
    }
  }
  await sweepOfflineDevices()
}

async function tick() {
  if (running || stopped) return
  running = true
  try {
    await processWhatsApp()
    if (Date.now() - lastHousekeeping > 5000) {
      lastHousekeeping = Date.now()
      await housekeeping()
    }
  } catch (err) {
    logger.error({ err }, 'dispatcher tick failed')
  } finally {
    running = false
    schedule(1000)
  }
}

function schedule(ms) {
  if (stopped) return
  clearTimeout(timer)
  timer = setTimeout(tick, ms)
}

export async function startDispatcher() {
  stopped = false
  // messages that were mid-send when the process died
  const interrupted = await query("SELECT id FROM vm_messages WHERE channel = 'whatsapp' AND status = 'sending'")
  for (const { id } of interrupted) await failAttempt(id, 'Interrupted by server restart')
  bus.on('wa:queued', () => schedule(20))
  schedule(500)
}

export function stopDispatcher() {
  stopped = true
  clearTimeout(timer)
}
