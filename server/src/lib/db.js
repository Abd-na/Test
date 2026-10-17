import mysql from 'mysql2/promise'
import { config } from '../config.js'
import { logger } from './logger.js'

/**
 * All tables live in Veta's own MySQL database and are prefixed with `vm_`
 * (Veta Messenger) so they never collide with the application's tables.
 */
export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  charset: 'utf8mb4',
  timezone: 'Z',
  supportBigNumbers: true,
  dateStrings: false
})

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'")
})

export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params)
  return rows
}

export async function one(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] ?? null
}

export async function exec(sql, params = []) {
  const [result] = await pool.query(sql, params)
  return result
}

export async function transaction(fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value))

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'

const MIGRATIONS = [
  {
    id: '001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS vm_api_keys (
        id VARCHAR(40) NOT NULL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        prefix VARCHAR(20) NOT NULL,
        key_hash CHAR(64) NOT NULL,
        last_used_at DATETIME(3) NULL,
        revoked_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY vm_api_keys_hash (key_hash)
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS vm_instances (
        id VARCHAR(40) NOT NULL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        phone VARCHAR(32) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'disconnected',
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        last_error VARCHAR(255) NULL,
        connected_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS vm_wa_auth (
        instance_id VARCHAR(40) NOT NULL,
        k VARCHAR(191) NOT NULL,
        v LONGTEXT NOT NULL,
        PRIMARY KEY (instance_id, k)
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS vm_sms_devices (
        id VARCHAR(40) NOT NULL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        token_prefix VARCHAR(20) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        model VARCHAR(120) NULL,
        app_version VARCHAR(40) NULL,
        battery TINYINT NULL,
        charging TINYINT(1) NULL,
        signal_level TINYINT NULL,
        sims TEXT NULL,
        last_seen_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY vm_sms_devices_token (token_hash)
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS vm_messages (
        id VARCHAR(40) NOT NULL PRIMARY KEY,
        direction VARCHAR(3) NOT NULL,
        channel VARCHAR(10) NOT NULL,
        instance_id VARCHAR(40) NULL,
        device_id VARCHAR(40) NULL,
        phone VARCHAR(80) NOT NULL,
        type VARCHAR(16) NOT NULL DEFAULT 'text',
        body TEXT NULL,
        media_url TEXT NULL,
        media_path VARCHAR(255) NULL,
        filename VARCHAR(255) NULL,
        mimetype VARCHAR(120) NULL,
        extra TEXT NULL,
        status VARCHAR(16) NOT NULL,
        priority TINYINT NOT NULL DEFAULT 0,
        provider_id VARCHAR(128) NULL,
        error VARCHAR(500) NULL,
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        fallback_channel VARCHAR(10) NULL,
        parent_id VARCHAR(40) NULL,
        fallback_id VARCHAR(40) NULL,
        otp_id VARCHAR(40) NULL,
        reference VARCHAR(191) NULL,
        metadata TEXT NULL,
        api_key_id VARCHAR(40) NULL,
        claim_token VARCHAR(40) NULL,
        sim TINYINT NULL,
        scheduled_at DATETIME(3) NULL,
        next_attempt_at DATETIME(3) NULL,
        expires_at DATETIME(3) NULL,
        locked_at DATETIME(3) NULL,
        sent_at DATETIME(3) NULL,
        delivered_at DATETIME(3) NULL,
        read_at DATETIME(3) NULL,
        failed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY vm_messages_queue (status, channel, next_attempt_at),
        KEY vm_messages_provider (provider_id),
        KEY vm_messages_reference (reference),
        KEY vm_messages_phone (phone),
        KEY vm_messages_claim (claim_token),
        KEY vm_messages_created (created_at)
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS vm_otps (
        id VARCHAR(40) NOT NULL PRIMARY KEY,
        phone VARCHAR(32) NOT NULL,
        purpose VARCHAR(64) NOT NULL DEFAULT 'default',
        code_hash CHAR(64) NOT NULL,
        channel VARCHAR(10) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 5,
        message_id VARCHAR(40) NULL,
        reference VARCHAR(191) NULL,
        ip VARCHAR(64) NULL,
        expires_at DATETIME(3) NOT NULL,
        verified_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        KEY vm_otps_lookup (phone, purpose, status),
        KEY vm_otps_created (phone, created_at)
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS vm_webhooks (
        id VARCHAR(40) NOT NULL PRIMARY KEY,
        url VARCHAR(500) NOT NULL,
        description VARCHAR(255) NULL,
        events TEXT NOT NULL,
        secret VARCHAR(100) NOT NULL,
        instance_id VARCHAR(40) NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ${TABLE}`,

      `CREATE TABLE IF NOT EXISTS vm_webhook_deliveries (
        id VARCHAR(40) NOT NULL PRIMARY KEY,
        webhook_id VARCHAR(40) NOT NULL,
        event VARCHAR(40) NOT NULL,
        payload LONGTEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        response_status INT NULL,
        response_body TEXT NULL,
        error VARCHAR(500) NULL,
        next_attempt_at DATETIME(3) NULL,
        delivered_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY vm_webhook_deliveries_queue (status, next_attempt_at),
        KEY vm_webhook_deliveries_hook (webhook_id, created_at)
      ) ${TABLE}`
    ]
  }
]

export async function migrate() {
  await exec(`CREATE TABLE IF NOT EXISTS vm_migrations (
    id VARCHAR(100) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL
  ) ${TABLE}`)
  const applied = new Set((await query('SELECT id FROM vm_migrations')).map((r) => r.id))
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue
    for (const sql of migration.statements) await exec(sql)
    await exec('INSERT INTO vm_migrations (id, applied_at) VALUES (?, ?)', [migration.id, new Date()])
    logger.info({ migration: migration.id }, 'migration applied')
  }
}
