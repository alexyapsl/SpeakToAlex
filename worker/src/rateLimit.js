const memoryBuckets = new Map();

export async function rateLimit(env, ip, { limit = 10, windowMs = 60_000 } = {}) {
  const keyIp = ip || "unknown";

  if (env.RATE_LIMIT_KV) {
    const key = `rate:${keyIp}`;
    const current = Number(await env.RATE_LIMIT_KV.get(key)) || 0;
    if (current >= limit) return { ok: false, limit, mode: "kv" };
    await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: Math.ceil(windowMs / 1000) });
    return { ok: true, limit, mode: "kv" };
  }

  const now = Date.now();
  const bucket = memoryBuckets.get(keyIp);
  if (!bucket || now > bucket.reset) {
    memoryBuckets.set(keyIp, { count: 1, reset: now + windowMs });
    return { ok: true, limit, mode: "memory" };
  }
  if (bucket.count >= limit) return { ok: false, limit, mode: "memory" };
  bucket.count += 1;
  return { ok: true, limit, mode: "memory" };
}
