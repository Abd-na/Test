import { assertConfig, config } from './config.js'
import { logger } from './lib/logger.js'
import { migrate, pool } from './lib/db.js'
import { createApp } from './app.js'
import { bootInstances, shutdownInstances } from './services/whatsapp/manager.js'
import { startDispatcher, stopDispatcher } from './services/dispatcher.js'
import { startWebhookWorker, stopWebhookWorker } from './services/webhooks.js'

assertConfig()
await migrate()
await startWebhookWorker()
await bootInstances()
await startDispatcher()

const server = createApp().listen(config.port, config.host, () => {
  logger.info(`Veta Messenger listening on http://${config.host}:${config.port} (public: ${config.publicUrl})`)
})
// long-poll requests from SMS phones last up to ~55s
server.requestTimeout = 120_000
server.headersTimeout = 65_000
server.keepAliveTimeout = 65_000

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  logger.info({ signal }, 'shutting down')
  stopDispatcher()
  stopWebhookWorker()
  server.close()
  server.closeAllConnections?.()
  await shutdownInstances()
  await pool.end().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'))
