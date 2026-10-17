// Usage: npm run key:create -- "Veta app"
import { migrate, pool } from '../src/lib/db.js'
import { createApiKey } from '../src/services/api-keys.js'

const name = process.argv.slice(2).join(' ') || 'Veta app'
await migrate()
const key = await createApiKey(name)
console.log("\nAPI key created (shown only once, store it in Veta's .env):\n")
console.log(`  VETA_MESSENGER_KEY=${key.key}\n`)
await pool.end()
