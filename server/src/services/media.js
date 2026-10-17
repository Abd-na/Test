import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { randomString } from '../lib/ids.js'
import { signMediaPath } from '../lib/crypto.js'
import { badRequest } from '../lib/errors.js'

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
}

const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m.split(';')[0]]))
EXT_MIME.jpeg = 'image/jpeg'

export const extForMime = (mime) => MIME_EXT[mime] || MIME_EXT[(mime || '').split(';')[0]] || 'bin'
export const mimeForFile = (name) =>
  EXT_MIME[
    path
      .extname(name || '')
      .slice(1)
      .toLowerCase()
  ] || 'application/octet-stream'

export async function saveBuffer(buffer, { ext = 'bin', folder = 'out' } = {}) {
  if (buffer.length > config.media.maxBytes) throw badRequest(`Media exceeds ${config.media.maxBytes / 1048576}MB`)
  const dir = path.join(config.media.dir, folder)
  await fs.mkdir(dir, { recursive: true })
  const file = `${folder}/${Date.now()}_${randomString(10)}.${ext}`
  await fs.writeFile(path.join(config.media.dir, file), buffer)
  return file
}

/** Accepts raw base64 or a data URI (data:image/png;base64,...). */
export async function saveBase64(input, { mimetype, filename } = {}) {
  let data = String(input)
  const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(data)
  if (match) {
    mimetype ||= match[1]
    data = match[2]
  }
  const buffer = Buffer.from(data, 'base64')
  if (!buffer.length) throw badRequest('media_base64 is empty or invalid')
  mimetype ||= mimeForFile(filename)
  const fromName = filename ? path.extname(filename).slice(1).toLowerCase() : ''
  const ext = /^[a-z0-9]{1,8}$/.test(fromName) ? fromName : extForMime(mimetype)
  return { file: await saveBuffer(buffer, { ext, folder: 'out' }), mimetype }
}

export const absolutePath = (file) => {
  const full = path.resolve(config.media.dir, file)
  if (!full.startsWith(config.media.dir + path.sep)) throw badRequest('Invalid media path')
  return full
}

export const publicMediaUrl = (file) => `${config.publicUrl}/media/${file}?sig=${signMediaPath(file)}`
