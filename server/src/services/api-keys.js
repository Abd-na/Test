import { exec, one, query } from '../lib/db.js'
import { newId, randomString } from '../lib/ids.js'
import { sha256 } from '../lib/crypto.js'

const present = (row) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  last_used_at: row.last_used_at,
  revoked_at: row.revoked_at,
  created_at: row.created_at
})

/** Creates a key and returns the plaintext once; only its hash is stored. */
export async function createApiKey(name) {
  const key = `vk_live_${randomString(40)}`
  const row = {
    id: newId('key'),
    name: name || 'API key',
    prefix: key.slice(0, 14),
    key_hash: sha256(key),
    created_at: new Date()
  }
  await exec('INSERT INTO vm_api_keys SET ?', [row])
  return { ...present(row), key }
}

export async function listApiKeys() {
  return (await query('SELECT * FROM vm_api_keys ORDER BY created_at DESC')).map(present)
}

export async function revokeApiKey(id) {
  const res = await exec('UPDATE vm_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [new Date(), id])
  return res.affectedRows > 0
}

const lastTouched = new Map()

export async function findApiKey(key) {
  if (typeof key !== 'string' || !key.startsWith('vk_')) return null
  const row = await one('SELECT * FROM vm_api_keys WHERE key_hash = ? AND revoked_at IS NULL', [sha256(key)])
  if (!row) return null
  // avoid a write on every request: refresh last_used_at at most once a minute
  const now = Date.now()
  if ((lastTouched.get(row.id) ?? 0) < now - 60_000) {
    lastTouched.set(row.id, now)
    exec('UPDATE vm_api_keys SET last_used_at = ? WHERE id = ?', [new Date(), row.id]).catch(() => {})
  }
  return present(row)
}
