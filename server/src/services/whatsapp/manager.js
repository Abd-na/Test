import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import { config } from '../../config.js'
import { exec, one, query } from '../../lib/db.js'
import { newId } from '../../lib/ids.js'
import { logger } from '../../lib/logger.js'
import { publish } from '../../lib/events.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { normalizePhone } from '../../lib/phone.js'
import { clearAuthState, useMySQLAuthState } from './auth-state.js'
import { advanceByProviderId, mediaFileFor, recordInbound } from '../messages.js'
import { extForMime, publicMediaUrl, saveBuffer } from '../media.js'

const waLogger = logger.child({ module: 'baileys' })
waLogger.level = config.logLevel === 'debug' ? 'info' : 'warn'

let cachedVersion = null
async function waVersion() {
  if (cachedVersion) return cachedVersion
  try {
    const { version } = await fetchLatestBaileysVersion()
    cachedVersion = version
  } catch {
    cachedVersion = undefined // let Baileys use its bundled default
  }
  return cachedVersion
}

// WhatsApp ack levels → our statuses (1 = pending, 2 = server ack, 3 = delivered, 4 = read, 5 = played)
const ACK_STATUS = { 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' }

export class PermanentError extends Error {
  constructor(message) {
    super(message)
    this.permanent = true
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class WhatsAppSession {
  constructor(row) {
    this.id = row.id
    this.name = row.name
    this.phone = row.phone
    this.status = 'disconnected'
    this.qr = null
    this.qrUpdatedAt = null
    this.sock = null
    this.stopped = true
    this.retries = 0
    this.reconnectTimer = null
    this.onWhatsAppCache = new Map()
  }

  get connected() {
    return this.status === 'connected' && Boolean(this.sock)
  }

  async setStatus(status, extra = {}) {
    this.status = status
    await exec('UPDATE vm_instances SET ? WHERE id = ?', [{ status, updated_at: new Date(), ...extra }, this.id])
  }

  async start() {
    clearTimeout(this.reconnectTimer)
    this.stopped = false
    const { state, saveCreds } = await useMySQLAuthState(this.id)
    const sock = makeWASocket({
      version: await waVersion(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
      logger: waLogger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false, // keep phone notifications working on the linked phone
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    })
    this.sock = sock
    this.creds = state.creds
    if (this.status !== 'qr') await this.setStatus('connecting')
    this.armWatchdog(sock)

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (update) =>
      this.onConnectionUpdate(sock, update).catch((err) => {
        logger.error({ err, instance: this.id }, 'connection.update handler failed')
      })
    )
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        this.onIncoming(msg).catch((err) => logger.error({ err, instance: this.id }, 'incoming message failed'))
      }
    })
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        const status = ACK_STATUS[update?.status]
        if (key?.fromMe && key.id && status) advanceByProviderId(key.id, status).catch(() => {})
      }
    })
  }

  /** If WhatsApp never answers (firewall, DNS), retry instead of hanging in "connecting". */
  armWatchdog(sock) {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(async () => {
      if (sock !== this.sock || this.stopped || this.status !== 'connecting') return
      logger.warn({ instance: this.id }, 'WhatsApp did not answer, retrying')
      await this.setStatus('connecting', { last_error: 'Cannot reach WhatsApp servers, retrying' }).catch(() => {})
      this.sock = null
      try {
        sock.end(undefined)
      } catch {
        // ignore
      }
      this.reconnectTimer = setTimeout(
        () => {
          this.start().catch((err) => logger.error({ err, instance: this.id }, 'reconnect failed'))
        },
        Math.min(5000 * 2 ** this.retries++, 120_000)
      )
    }, 45_000)
  }

  async onConnectionUpdate(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return // stale socket from a previous connection
    if (qr || connection === 'open' || connection === 'close') clearTimeout(this.watchdog)
    if (qr) {
      this.qr = qr
      this.qrUpdatedAt = new Date()
      await this.setStatus('qr')
    }
    if (connection === 'open') {
      this.retries = 0
      this.qr = null
      this.phone = jidNormalizedUser(sock.user?.id).split('@')[0] || this.phone
      await this.setStatus('connected', { phone: this.phone, connected_at: new Date(), last_error: null })
      logger.info({ instance: this.id, phone: this.phone }, 'WhatsApp connected')
      publish('instance.connected', await getInstance(this.id))
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const reason = lastDisconnect?.error?.message ?? 'closed'
      this.sock = null
      logger.warn({ instance: this.id, code, reason }, 'WhatsApp connection closed')

      if (code === DisconnectReason.loggedOut) {
        await clearAuthState(this.id)
        this.stopped = true
        this.qr = null
        await this.setStatus('logged_out', { last_error: 'Logged out from phone' })
        publish('instance.logged_out', await getInstance(this.id))
        return
      }
      if (this.stopped) return
      const registered = Boolean(this.creds?.registered)
      // Never paired and QR timed out: wait for the user to request a new QR
      if (!registered && code !== DisconnectReason.restartRequired) {
        this.stopped = true
        const hadQr = Boolean(this.qr)
        this.qr = null
        await this.setStatus('disconnected', {
          last_error: hadQr ? 'QR code expired, press connect again' : `${reason} (${code ?? '?'})`.slice(0, 255)
        })
        return
      }
      if (code === DisconnectReason.connectionReplaced || code === DisconnectReason.forbidden) {
        this.stopped = true
        await this.setStatus('disconnected', { last_error: `${reason} (${code})` })
        publish('instance.disconnected', await getInstance(this.id))
        return
      }
      const wasConnected = this.status === 'connected'
      await this.setStatus('connecting', { last_error: `${reason} (${code ?? '?'})`.slice(0, 255) })
      if (wasConnected) publish('instance.disconnected', await getInstance(this.id))
      const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(1000 * 2 ** this.retries++, 60_000)
      this.reconnectTimer = setTimeout(() => {
        this.start().catch((err) => logger.error({ err, instance: this.id }, 'reconnect failed'))
      }, delay)
    }
  }

  senderOf(key) {
    // Baileys v7 may address chats by LID; prefer the phone-number JID when available
    const pick = (jid, alt) => (isLidUser(jid) && alt ? alt : jid)
    if (isJidGroup(key.remoteJid)) {
      return {
        phone: jidNormalizedUser(pick(key.participant, key.participantAlt)).split('@')[0],
        group: key.remoteJid
      }
    }
    return { phone: jidNormalizedUser(pick(key.remoteJid, key.remoteJidAlt)).split('@')[0], group: null }
  }

  async onIncoming(msg) {
    const { key } = msg
    if (!key || key.fromMe || key.remoteJid === 'status@broadcast' || key.remoteJid?.endsWith('@newsletter')) return
    const content = normalizeMessageContent(msg.message)
    const kind = content && getContentType(content)
    if (!kind || ['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage'].includes(kind)) return

    const inner = content[kind] ?? {}
    const typeMap = {
      conversation: 'text',
      extendedTextMessage: 'text',
      imageMessage: 'image',
      videoMessage: 'video',
      audioMessage: 'audio',
      documentMessage: 'document',
      documentWithCaptionMessage: 'document',
      stickerMessage: 'sticker',
      locationMessage: 'location',
      liveLocationMessage: 'location',
      contactMessage: 'contact',
      buttonsResponseMessage: 'text',
      listResponseMessage: 'text',
      templateButtonReplyMessage: 'text'
    }
    const type = typeMap[kind] ?? kind.replace(/Message$/, '')
    const body =
      content.conversation ??
      inner.text ??
      inner.caption ??
      inner.selectedDisplayText ??
      inner.selectedButtonId ??
      inner.title ??
      inner.displayName ??
      null

    const { phone, group } = this.senderOf(key)
    const extra = { push_name: msg.pushName || undefined }
    if (group) extra.group = group
    if (type === 'location') {
      extra.location = {
        latitude: inner.degreesLatitude,
        longitude: inner.degreesLongitude,
        name: inner.name,
        address: inner.address
      }
    }

    let mediaPath = null
    let mediaUrl = null
    const isMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(type)
    const size = Number(inner.fileLength ?? 0)
    if (isMedia && config.whatsapp.downloadMedia && size <= config.media.maxBytes) {
      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: waLogger, reuploadRequest: this.sock?.updateMediaMessage }
        )
        mediaPath = await saveBuffer(buffer, { ext: extForMime(inner.mimetype), folder: 'in' })
        mediaUrl = publicMediaUrl(mediaPath)
      } catch (err) {
        logger.warn({ err: err.message, instance: this.id }, 'could not download incoming media')
      }
    }

    await recordInbound({
      channel: 'whatsapp',
      instance_id: this.id,
      phone,
      type,
      body,
      media_path: mediaPath,
      media_url: mediaUrl,
      mimetype: inner.mimetype ?? null,
      filename: inner.fileName ?? null,
      provider_id: key.id,
      extra,
      received_at: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date()
    })

    if (config.whatsapp.autoRead && this.sock) this.sock.readMessages([key]).catch(() => {})
  }

  async exists(phone) {
    if (phone.includes('@')) return phone
    const cached = this.onWhatsAppCache.get(phone)
    if (cached && cached.at > Date.now() - 24 * 3600 * 1000) return cached.jid
    const [result] = await this.sock.onWhatsApp(phone)
    const jid = result?.exists ? result.jid : null
    this.onWhatsAppCache.set(phone, { jid, at: Date.now() })
    return jid
  }

  async checkNumbers(phones) {
    if (!this.connected) throw conflict('Instance is not connected')
    const results = await this.sock.onWhatsApp(...phones)
    const found = new Map(results.filter((r) => r.exists).map((r) => [r.jid.split('@')[0], r.jid]))
    return phones.map((phone) => ({ phone, exists: found.has(phone), jid: found.get(phone) ?? null }))
  }

  buildContent(row, extra) {
    const media = row.media_path ? { url: mediaFileFor(row) } : row.media_url ? { url: row.media_url } : null
    const caption = row.body || undefined
    switch (row.type) {
      case 'text':
        return { text: row.body }
      case 'image':
        return { image: media, caption }
      case 'video':
        return { video: media, caption }
      case 'audio':
        return {
          audio: media,
          mimetype: row.mimetype || (extra.ptt ? 'audio/ogg; codecs=opus' : 'audio/mp4'),
          ptt: Boolean(extra.ptt)
        }
      case 'document':
        return {
          document: media,
          mimetype: row.mimetype || 'application/octet-stream',
          fileName: row.filename || 'file',
          caption
        }
      case 'location':
        return {
          location: {
            degreesLatitude: extra.location.latitude,
            degreesLongitude: extra.location.longitude,
            name: extra.location.name,
            address: extra.location.address
          }
        }
      default:
        throw new PermanentError(`Unsupported message type ${row.type}`)
    }
  }

  /** Sends one queued message row. Returns the WhatsApp message id. */
  async send(row, extra) {
    if (!this.connected) throw new Error('Instance is not connected')
    const jid = row.phone.includes('@') ? row.phone : await this.exists(row.phone)
    if (!jid) throw new PermanentError('Number is not registered on WhatsApp')
    const content = this.buildContent(row, extra)

    if (config.whatsapp.typing && !jid.endsWith('@g.us')) {
      try {
        await this.sock.sendPresenceUpdate(row.type === 'audio' ? 'recording' : 'composing', jid)
        await sleep(Math.min(800 + (row.body?.length ?? 0) * 25, 4000))
        await this.sock.sendPresenceUpdate('paused', jid)
      } catch {
        // presence is cosmetic only
      }
    }
    const sent = await this.sock.sendMessage(jid, content)
    return sent?.key?.id ?? null
  }

  async requestPairingCode(phone) {
    if (this.connected) throw conflict('Instance is already connected')
    if (this.creds?.registered) throw conflict('Instance already paired; logout first')
    if (!this.sock) await this.start()
    // the socket needs a moment to open the websocket before requesting a code
    for (let i = 0; i < 20 && !this.sock?.ws?.isOpen; i++) await sleep(250)
    return this.sock.requestPairingCode(phone)
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.watchdog)
    const sock = this.sock
    this.sock = null
    try {
      sock?.end(undefined)
    } catch {
      // ignore
    }
  }

  async logout() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    try {
      await this.sock?.logout()
    } catch {
      // already disconnected
    }
    await this.stop()
    await clearAuthState(this.id)
    this.qr = null
    this.creds = null
    await this.setStatus('logged_out', { phone: null })
  }
}

const sessions = new Map()

async function presentInstance(row) {
  const session = sessions.get(row.id)
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: session?.status ?? row.status,
    is_default: Boolean(row.is_default),
    last_error: row.last_error,
    has_qr: Boolean(session?.qr),
    connected_at: row.connected_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export async function getInstance(id) {
  const row = await one('SELECT * FROM vm_instances WHERE id = ?', [id])
  if (!row) throw notFound('Instance')
  return presentInstance(row)
}

export async function listInstances() {
  const rows = await query('SELECT * FROM vm_instances ORDER BY is_default DESC, created_at ASC')
  return Promise.all(rows.map(presentInstance))
}

export async function createInstance({ name, connect = true }) {
  const now = new Date()
  const count = (await one('SELECT COUNT(*) AS c FROM vm_instances')).c
  const row = {
    id: newId('wa', 16),
    name: name || `WhatsApp ${Number(count) + 1}`,
    status: 'disconnected',
    is_default: Number(count) === 0 ? 1 : 0,
    created_at: now,
    updated_at: now
  }
  await exec('INSERT INTO vm_instances SET ?', [row])
  const session = new WhatsAppSession(row)
  session.isDefault = row.is_default
  sessions.set(row.id, session)
  if (connect) await session.start()
  return getInstance(row.id)
}

export async function updateInstance(id, { name, is_default }) {
  await getInstance(id)
  if (is_default) await exec('UPDATE vm_instances SET is_default = 0')
  const fields = { updated_at: new Date() }
  if (name) fields.name = name
  if (is_default !== undefined) fields.is_default = is_default ? 1 : 0
  await exec('UPDATE vm_instances SET ? WHERE id = ?', [fields, id])
  await refreshDefaults()
  return getInstance(id)
}

export function session(id) {
  const s = sessions.get(id)
  if (!s) throw notFound('Instance')
  return s
}

export async function connectInstance(id) {
  const s = session(id)
  if (s.connected) return getInstance(id)
  await s.stop()
  await s.start()
  return getInstance(id)
}

export async function restartInstance(id) {
  const s = session(id)
  await s.stop()
  s.status = 'connecting'
  await s.start()
  return getInstance(id)
}

export async function logoutInstance(id) {
  await session(id).logout()
  return getInstance(id)
}

export async function deleteInstance(id) {
  const s = session(id)
  await s.logout()
  sessions.delete(id)
  await exec('DELETE FROM vm_instances WHERE id = ?', [id])
}

export async function instanceQr(id) {
  const s = session(id)
  return {
    status: s.status,
    qr: s.qr,
    qr_image: s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 320 }) : null,
    updated_at: s.qrUpdatedAt
  }
}

export async function pairingCode(id, phone) {
  const normalized = normalizePhone(phone)
  if (normalized.includes('@')) throw badRequest('phone must be a phone number')
  return { code: await session(id).requestPairingCode(normalized) }
}

export async function instanceGroups(id) {
  const s = session(id)
  if (!s.connected) throw conflict('Instance is not connected')
  const groups = await s.sock.groupFetchAllParticipating()
  return Object.values(groups).map((g) => ({ id: g.id, subject: g.subject, participants: g.participants?.length ?? 0 }))
}

export async function checkNumbers(phones, instanceId) {
  const s = instanceId ? session(instanceId) : connectedSessions()[0]
  if (!s) throw conflict('No connected WhatsApp instance')
  return s.checkNumbers(phones.map((p) => normalizePhone(p)).filter((p) => !p.includes('@')))
}

/** Connected sessions, default instance first. */
export function connectedSessions() {
  return [...sessions.values()].filter((s) => s.connected).sort((a, b) => (b.isDefault ?? 0) - (a.isDefault ?? 0))
}

export async function refreshDefaults() {
  const rows = await query('SELECT id, is_default FROM vm_instances')
  for (const r of rows) if (sessions.has(r.id)) sessions.get(r.id).isDefault = r.is_default
}

/** Boots every paired instance on server start. */
export async function bootInstances() {
  const rows = await query('SELECT * FROM vm_instances')
  for (const row of rows) {
    const s = new WhatsAppSession(row)
    s.isDefault = row.is_default
    sessions.set(row.id, s)
    const hasCreds = await one("SELECT 1 AS ok FROM vm_wa_auth WHERE instance_id = ? AND k = 'creds'", [row.id])
    if (hasCreds) {
      s.start().catch((err) => logger.error({ err, instance: row.id }, 'failed to start instance'))
    } else if (row.status !== 'logged_out') {
      await s.setStatus('disconnected')
    }
  }
}

export async function shutdownInstances() {
  for (const s of sessions.values()) await s.stop()
}
