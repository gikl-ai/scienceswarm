// Simple in-memory sliding window rate limiter
// No external dependencies

interface RateLimitConfig {
  windowMs: number;    // time window in ms
  maxRequests: number; // max requests per window
}

const LIMITS: Record<string, RateLimitConfig> = {
  web: { windowMs: 60_000, maxRequests: 30 },
  telegram: { windowMs: 60_000, maxRequests: 20 },
  slack: { windowMs: 60_000, maxRequests: 20 },
  api: { windowMs: 60_000, maxRequests: 60 },
};

// Store: Map<key, timestamp[]>
const store = new Map<string, number[]>();

export function checkRateLimit(
  identifier: string, // e.g., userId or IP
  channel: string = "web"
): { allowed: boolean; remaining: number; resetMs: number } {
  const config = LIMITS[channel] || LIMITS.api;
  const key = `${channel}:${identifier}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // Get existing timestamps, filter to current window
  const timestamps = (store.get(key) || []).filter(t => t > windowStart);

  if (timestamps.length >= config.maxRequests) {
    const oldestInWindow = timestamps[0];
    return {
      allowed: false,
      remaining: 0,
      resetMs: oldestInWindow + config.windowMs - now,
    };
  }

  timestamps.push(now);
  store.set(key, timestamps);

  return {
    allowed: true,
    remaining: config.maxRequests - timestamps.length,
    resetMs: config.windowMs,
  };
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of store.entries()) {
    const filtered = timestamps.filter(t => t > now - 120_000);
    if (filtered.length === 0) store.delete(key);
    else store.set(key, filtered);
  }
}, 60_000);
