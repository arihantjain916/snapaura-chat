import { createClient } from "redis";

/**
 * Single shared Redis connection.
 *
 * This used to be created in index.ts and passed by hand into the socket
 * handlers, which meant nothing else could reach it and there was no single
 * place to know whether it was actually up.
 */
export const redis = createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  },
});

let ready = false;

redis.on("error", (err) => {
  ready = false;
  console.error("[redis] connection error:", err?.message ?? err);
});

redis.on("ready", () => {
  ready = true;
});

redis.on("end", () => {
  ready = false;
});

export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
  } catch (err: any) {
    // The process still starts: Redis is a cache and a rate-limit store here,
    // not a source of truth. Callers degrade instead of failing.
    console.error("[redis] initial connect failed:", err?.message ?? err);
  }
}

export function redisReady(): boolean {
  return ready;
}

export async function disconnectRedis(): Promise<void> {
  if (redis.isOpen) {
    await redis.quit();
  }
}
