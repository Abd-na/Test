import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  // .env is optional: variables may come from Docker / PM2 / systemd
}

const env = process.env

const str = (key, def = '') => (env[key] ?? def).toString().trim()
const int = (key, def) => {
  const v = Number.parseInt(env[key] ?? '', 10)
  return Number.isFinite(v) ? v : def
}
const bool = (key, def) => {
  if (env[key] === undefined || env[key] === '') return def
  return ['1', 'true', 'yes', 'on'].includes(env[key].toLowerCase())
}

export const config = {
  root: ROOT,
  env: str('NODE_ENV', 'production'),
  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 3100),
  publicUrl: str('PUBLIC_URL', 'http://localhost:3100').replace(/\/+$/, ''),
  trustProxy: int('TRUST_PROXY', 1),
  logLevel: str('LOG_LEVEL', 'info'),

  appName: str('APP_NAME', 'Veta'),
  appSecret: str('APP_SECRET'),
  adminPassword: str('ADMIN_PASSWORD'),

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    user: str('DB_USERNAME', str('DB_USER', 'root')),
    password: str('DB_PASSWORD'),
    database: str('DB_DATABASE', str('DB_NAME', 'sms_wa_gateway')),
    socketPath: str('DB_SOCKET') || undefined,
    connectionLimit: int('DB_POOL_SIZE', 10)
  },

  defaultCountryCode: str('DEFAULT_COUNTRY_CODE').replace(/\D/g, ''),

  whatsapp: {
    minDelayMs: int('WA_MIN_DELAY_MS', 2500),
    maxDelayMs: int('WA_MAX_DELAY_MS', 6000),
    typing: bool('WA_TYPING', true),
    autoRead: bool('WA_AUTO_READ', false),
    downloadMedia: bool('WA_DOWNLOAD_MEDIA', true)
  },

  sms: {
    minDelayMs: int('SMS_MIN_DELAY_MS', 1500),
    // queued SMS waiting for an online phone longer than this fails (or falls back)
    queueTimeoutSec: int('SMS_QUEUE_TIMEOUT_SEC', 600),
    // a phone that claimed an SMS but never reported back within this is assumed dead
    sendTimeoutSec: int('SMS_SEND_TIMEOUT_SEC', 300),
    deviceOnlineSec: int('SMS_DEVICE_ONLINE_SEC', 90)
  },

  messages: {
    maxAttempts: int('MESSAGE_MAX_ATTEMPTS', 3)
  },

  otp: {
    length: int('OTP_LENGTH', 6),
    ttlSec: int('OTP_TTL_SEC', 300),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    resendCooldownSec: int('OTP_RESEND_COOLDOWN_SEC', 60),
    maxPerHour: int('OTP_MAX_PER_HOUR', 5),
    template: str(
      'OTP_TEMPLATE',
      'رمز التحقق الخاص بك في {app} هو: {code}\nصالح لمدة {minutes} دقائق. لا تشاركه مع أي أحد.'
    ).replace(/\\n/g, '\n')
  },

  media: {
    dir: path.resolve(ROOT, str('MEDIA_DIR', './data/media')),
    maxBytes: int('MEDIA_MAX_MB', 16) * 1024 * 1024
  }
}

export function assertConfig() {
  const problems = []
  if (config.appSecret.length < 32) problems.push('APP_SECRET must be at least 32 characters')
  if (config.adminPassword.length < 8) problems.push('ADMIN_PASSWORD must be at least 8 characters')
  if (problems.length) {
    throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`)
  }
}
