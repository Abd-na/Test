import { EventEmitter } from 'node:events'

/**
 * In-process event bus. Every event published here is also fanned out to
 * matching webhooks by the webhook service.
 */
export const bus = new EventEmitter()
bus.setMaxListeners(50)

export const EVENTS = [
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'message.received',
  'instance.connected',
  'instance.disconnected',
  'instance.logged_out',
  'device.online',
  'device.offline',
  'otp.verified'
]

export const publish = (event, data) => bus.emit('event', { event, data })
