// PM2: pm2 start ecosystem.config.cjs && pm2 save
// Keep instances = 1: WhatsApp sessions and the send queue live in this single process.
module.exports = {
  apps: [
    {
      name: 'veta-messenger',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '700M',
      kill_timeout: 15000,
      env: { NODE_ENV: 'production' }
    }
  ]
}
