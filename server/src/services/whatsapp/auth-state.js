import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys'
import { exec, query } from '../../lib/db.js'

const encode = (value) => JSON.stringify(value, BufferJSON.replacer)
const decode = (text) => JSON.parse(text, BufferJSON.reviver)

/**
 * Baileys auth state persisted in MySQL (vm_wa_auth) instead of files, so a
 * WhatsApp session survives restarts/redeploys and is backed up with the DB.
 */
export async function useMySQLAuthState(instanceId) {
  const [credsRow] = await query('SELECT v FROM vm_wa_auth WHERE instance_id = ? AND k = ?', [instanceId, 'creds'])
  const creds = credsRow ? decode(credsRow.v) : initAuthCreds()

  async function writeMany(entries) {
    if (!entries.length) return
    // chunk to keep packets reasonably small
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = entries.slice(i, i + 200)
      await exec('INSERT INTO vm_wa_auth (instance_id, k, v) VALUES ? ON DUPLICATE KEY UPDATE v = VALUES(v)', [
        chunk.map(([k, v]) => [instanceId, k, encode(v)])
      ])
    }
  }

  async function removeMany(keys) {
    if (!keys.length) return
    await exec('DELETE FROM vm_wa_auth WHERE instance_id = ? AND k IN (?)', [instanceId, keys])
  }

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const result = {}
          if (!ids.length) return result
          const rows = await query('SELECT k, v FROM vm_wa_auth WHERE instance_id = ? AND k IN (?)', [
            instanceId,
            ids.map((id) => `${type}-${id}`)
          ])
          const byKey = new Map(rows.map((r) => [r.k, r.v]))
          for (const id of ids) {
            const raw = byKey.get(`${type}-${id}`)
            let value = raw ? decode(raw) : undefined
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            result[id] = value
          }
          return result
        },
        async set(data) {
          const writes = []
          const deletes = []
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id]
              const key = `${category}-${id}`
              if (value) writes.push([key, value])
              else deletes.push(key)
            }
          }
          await writeMany(writes)
          await removeMany(deletes)
        }
      }
    },
    saveCreds: () => writeMany([['creds', creds]]),
    hasSession: Boolean(credsRow)
  }
}

export const clearAuthState = (instanceId) => exec('DELETE FROM vm_wa_auth WHERE instance_id = ?', [instanceId])
