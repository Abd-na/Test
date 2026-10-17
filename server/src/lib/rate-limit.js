/** Tiny fixed-window in-memory limiter (single process). */
export function createLimiter({ windowMs, max }) {
  const hits = new Map()
  setInterval(() => {
    const now = Date.now()
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k)
  }, windowMs).unref()

  return function take(key) {
    const now = Date.now()
    let entry = hits.get(key)
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs }
      hits.set(key, entry)
    }
    entry.count++
    return { ok: entry.count <= max, retryAfterSec: Math.ceil((entry.reset - now) / 1000) }
  }
}
