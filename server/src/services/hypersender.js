import { one, parseJson } from '../lib/db.js'
import { newId } from '../lib/ids.js'

/**
 * Converters between Veta Messenger and the Hypersender API / webhook formats,
 * so apps built on Hypersender (e.g. its Laravel SDK) work unchanged.
 */

/** "9647701234567@c.us" | "...@s.whatsapp.net" | "+964..." → "9647701234567"; groups stay JIDs. */
export function chatIdToPhone(chatId) {
  const s = String(chatId ?? '').trim()
  if (s.endsWith('@g.us')) return s
  return s.replace(/@(c\.us|s\.whatsapp\.net|lid)$/, '')
}

export const phoneToChatId = (phone) => (String(phone).includes('@') ? phone : `${phone}@c.us`)
const toJid = (phone) => (String(phone).includes('@') ? phone : `${phone}@s.whatsapp.net`)
const seconds = (d) => Math.floor(new Date(d ?? Date.now()).getTime() / 1000)
const stamp = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : null)

/** Response of /send-text, /send-image… (Baileys-like message, status PENDING). */
export function waSendResponse(msg) {
  const caption = msg.text ?? undefined
  const content = {
    text: { extendedTextMessage: { text: msg.text } },
    image: { imageMessage: { url: msg.media_url, mimetype: msg.mimetype, caption } },
    video: { videoMessage: { url: msg.media_url, mimetype: msg.mimetype, caption } },
    audio: { audioMessage: { url: msg.media_url, mimetype: msg.mimetype, ptt: true } },
    document: { documentMessage: { url: msg.media_url, mimetype: msg.mimetype, fileName: msg.filename, caption } },
    location: {
      locationMessage: {
        degreesLatitude: msg.location?.latitude,
        degreesLongitude: msg.location?.longitude,
        name: msg.location?.name
      }
    }
  }[msg.type] ?? { conversation: msg.text }
  return {
    key: { remoteJid: toJid(msg.to), fromMe: true, id: msg.id },
    message: content,
    messageTimestamp: seconds(msg.created_at),
    status: 'PENDING'
  }
}

export const notOnWhatsappError = (phone) => ({
  message: 'The given data was invalid.',
  errors: {
    messages: ['The number you want to send the message to is not on whatsapp.'],
    jid: toJid(phone),
    exists: false
  },
  statusCode: 422
})

const SMS_STATUS = {
  queued: 'pending',
  sending: 'scheduled',
  sent: 'sent',
  delivered: 'delivered',
  failed: 'failed',
  received: 'received',
  cancelled: 'deleted'
}

export function smsPhoneObject(device) {
  if (!device) return null
  // the app reports only the SIM a device is paired to (one device per SIM on dual-SIM phones)
  const sims = typeof device.sims === 'string' ? parseJson(device.sims, []) : (device.sims ?? [])
  const online = Boolean(device.online ?? (device.last_seen_at && Date.now() - new Date(device.last_seen_at) < 90_000))
  return {
    id: device.id,
    user_id: null,
    phone_number: null,
    name: device.name,
    sim: sims.length === 1 && sims[0]?.slot ? `SIM${sims[0].slot}` : 'SIM1',
    is_online: online,
    last_heartbeat_at: stamp(device.last_seen_at),
    created_at: stamp(device.created_at),
    updated_at: stamp(device.updated_at ?? device.last_seen_at)
  }
}

/** Hypersender SMS message object (send-message response, list items, webhook data). */
export function smsMessageObject(msg, device = null) {
  const inbound = msg.direction === 'inbound'
  return {
    id: msg.id,
    request_id: msg.reference ?? msg.id,
    phone: smsPhoneObject(device),
    message_thread_id: `thread_${inbound ? msg.from : msg.to}`,
    phone_id: msg.device_id,
    from_phone_number: inbound ? `+${msg.from}`.replace(/^\+(\D)/, '$1') : null,
    to_phone_number: inbound ? null : `+${msg.to}`,
    content: msg.text,
    send_duration: null,
    schedule_on_phone_at: stamp(msg.scheduled_at),
    sent_at: stamp(msg.sent_at && !inbound ? msg.sent_at : null),
    last_attempted_at: stamp(msg.updated_at),
    delivered_at: stamp(msg.delivered_at),
    received_at: inbound ? stamp(msg.sent_at ?? msg.created_at) : null,
    expired_at: null,
    schedule_send_at: stamp(msg.scheduled_at),
    failed_at: stamp(msg.failed_at),
    send_attempt_count: msg.attempts ?? 0,
    max_send_attempts: null,
    failure_reason: msg.error ?? null,
    message_expiration_seconds: null,
    timezone: 'UTC',
    sim: msg.sim ? `SIM${msg.sim}` : 'SIM1',
    status: SMS_STATUS[msg.status] ?? msg.status,
    type: inbound ? 'received_from_mobile' : 'sent_to_mobile',
    created_at: stamp(msg.created_at),
    updated_at: stamp(msg.updated_at)
  }
}

const ACK = { sent: [1, 'SERVER'], delivered: [2, 'DEVICE'], read: [3, 'READ'], failed: [-1, 'ERROR'] }

async function waEnvelope(event, data, payload) {
  const instance = data.instance_id
    ? await one('SELECT id, name, phone FROM vm_instances WHERE id = ?', [data.instance_id])
    : null
  return {
    event,
    data: {
      id: newId('evt'),
      event,
      metadata: [],
      me: instance?.phone ? { id: phoneToChatId(instance.phone), pushName: instance.name } : null,
      payload,
      instanceId: data.instance_id ?? null,
      userId: null
    }
  }
}

/** Channel an event belongs to (for webhooks restricted to WhatsApp or SMS). */
export function eventChannel(event, data) {
  if (data?.channel) return data.channel
  if (event.startsWith('device.')) return 'sms'
  if (event.startsWith('instance.')) return 'whatsapp'
  return null
}

/** Our event → Hypersender webhook body, or null when Hypersender has no equivalent. */
export async function toHypersenderWebhook(event, data) {
  const channel = eventChannel(event, data)
  if (channel === 'whatsapp' && event === 'message.received') {
    const from = data.group ? data.group : phoneToChatId(data.from)
    return waEnvelope('message.any', data, {
      id: `false_${from}_${data.provider_id ?? data.id}`,
      timestamp: seconds(data.sent_at ?? data.created_at),
      from,
      fromMe: false,
      source: 'app',
      body: data.text ?? '',
      hasMedia: Boolean(data.media_url),
      media: data.media_url ? { url: data.media_url, mimetype: data.mimetype, filename: data.filename } : null,
      ack: null,
      replyTo: null,
      _data: {
        key: { remoteJid: toJid(data.group ?? data.from), fromMe: false, id: data.provider_id ?? data.id },
        pushName: data.push_name ?? null,
        message: { conversation: data.text ?? '' }
      }
    })
  }
  if (channel === 'whatsapp' && ACK[event.replace('message.', '')]) {
    const [ack, ackName] = ACK[event.replace('message.', '')]
    const to = phoneToChatId(data.to)
    return waEnvelope('message.ack', data, { id: `true_${to}_${data.id}`, from: to, fromMe: true, ack, ackName })
  }
  if (channel === 'sms') {
    const name = {
      'message.sent': 'message.phone.sent',
      'message.delivered': 'message.phone.delivered',
      'message.failed': 'message.send.failed',
      'message.received': 'message.phone.received',
      'device.online': 'phone.heartbeat.online',
      'device.offline': 'phone.heartbeat.offline'
    }[event]
    if (!name) return null
    if (event.startsWith('device.')) return { event: name, data: smsPhoneObject(data) }
    const device = data.device_id ? await one('SELECT * FROM vm_sms_devices WHERE id = ?', [data.device_id]) : null
    return { event: name, data: smsMessageObject(data, device) }
  }
  return null
}

/** A valid Hypersender event for the "send test" button (the SDK rejects unknown events). */
export function hypersenderTestEvent(channel) {
  if (channel === 'sms') {
    return {
      event: 'phone.heartbeat.received',
      data: { id: newId('hb'), battery_level: 100, is_charging: true, local_timestamp: stamp(new Date()) }
    }
  }
  return {
    event: 'presence.update',
    data: { id: newId('evt'), event: 'presence.update', metadata: [], payload: { id: 'test@c.us', presences: [] } }
  }
}
