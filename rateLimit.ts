import { NextFunction, Request, Response } from "express";
import { redis, redisReady } from "./redisClient";

/**
 * Fixed-window rate limiting, backed by Redis so the count is shared when more
 * than one instance is running, with an in-process fallback for when Redis is
 * unavailable. Nothing in this service was rate limited before.
 */
const memoryHits = new Map<string, { count: number; expiresAt: number }>();

// Keeps the fallback map from growing without bound.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryHits) {
    if (entry.expiresAt <= now) {
      memoryHits.delete(key);
    }
  }
}, 60_000);
sweep.unref?.();

async function hit(key: string, windowSeconds: number): Promise<number> {
  if (redisReady()) {
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }
      return count;
    } catch {
      // Fall through to the in-process counter.
    }
  }

  const now = Date.now();
  const entry = memoryHits.get(key);

  if (!entry || entry.expiresAt <= now) {
    memoryHits.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return 1;
  }

  entry.count += 1;
  return entry.count;
}

export function rateLimit(options: {
  name: string;
  limit: number;
  windowSeconds: number;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identity = (req as any).user?.id ?? req.ip ?? "unknown";
    const key = `ratelimit:${options.name}:${identity}`;

    try {
      const count = await hit(key, options.windowSeconds);

      if (count > options.limit) {
        res.status(429).json({
          success: false,
          message: "Too many requests, please slow down",
        });
        return;
      }
    } catch (err: any) {
      // A limiter failure must not take the endpoint down with it.
      console.error("[ratelimit] check failed:", err?.message ?? err);
    }

    next();
  };
}

/**
 * Counter for socket events, which do not pass through Express middleware.
 */
export async function consumeSocketQuota(
  userId: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const count = await hit(`ratelimit:socket:${userId}`, windowSeconds);
    return count <= limit;
  } catch {
    return true;
  }
}
