import axios from "axios";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import { redis, redisReady } from "./redisClient";

/**
 * No index signature: the shape is now exactly what toPublicUser() emits, so
 * a field added upstream cannot quietly ride along into chat payloads.
 */
export interface AuthUser {
  id: string;
  username?: string;
  name?: string;
  profile?: string;
}

const PROFILE_CACHE_SECONDS = 40;

/**
 * Reduce a user to the fields this service actually uses.
 *
 * The whole object used to be cached in Redis and forwarded into the
 * conversation list. Whatever the Laravel API happened to serialise came along
 * for the ride — the caller's own email address among it — so a field added
 * upstream would silently start appearing in chat payloads and in the cache.
 */
function toPublicUser(raw: any): AuthUser | undefined {
  if (!raw?.id) {
    return undefined;
  }

  return {
    id: String(raw.id),
    username: raw.username ?? undefined,
    name: raw.name ?? undefined,
    profile: raw.profile ?? undefined,
  };
}

/**
 * Redis keys used to be the raw bearer token (`user-${token}`), so anyone who
 * could read the keyspace — a dump, MONITOR, keyspace notifications — walked
 * away with live credentials.
 */
function cacheKey(token: string): string {
  return `user:${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Resolve the user behind a bearer token, or throw.
 *
 * The previous version returned the caught Error as though it were a user, so
 * callers happily carried on with `user.id === undefined`.
 */
export async function resolveUserFromToken(token: string): Promise<AuthUser> {
  if (!token) {
    throw new Error("Missing token");
  }

  // Cheap local check before spending a network call on an obvious forgery.
  jwt.verify(token, process.env.JWT_SECRET as string);

  const key = cacheKey(token);

  if (redisReady()) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as AuthUser;
      }
    } catch (err: any) {
      console.error("[cache] profile read failed:", err?.message ?? err);
    }
  }

  const response = await axios.get(`${process.env.API_URL}/user/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 5000,
  });

  // The Laravel API answers in one envelope now — { isSuccess, message, data }
  // — so the profile arrives under `data`. It used to be a top-level `user`.
  const user = toPublicUser(response?.data?.data);

  if (!user?.id) {
    throw new Error("Backend did not return a user");
  }

  if (redisReady()) {
    try {
      await redis.set(key, JSON.stringify(user), { EX: PROFILE_CACHE_SECONDS });
    } catch (err: any) {
      console.error("[cache] profile write failed:", err?.message ?? err);
    }
  }

  return user;
}

const USER_CACHE_SECONDS = 120;

/**
 * Look a user up by id over the service-to-service endpoint.
 *
 * Cached, because the conversation list calls this once per counterparty and
 * previously hammered the Laravel API with an uncached request per row on
 * every single load.
 */
export async function fetchUserById(userId: string): Promise<AuthUser | null> {
  const key = `user:id:${userId}`;

  if (redisReady()) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as AuthUser;
      }
    } catch {
      // Cache miss by another name.
    }
  }

  try {
    const response = await axios.get(
      `${process.env.API_URL}/user/info/${userId}`,
      {
        headers: { "SECRET-KEY": process.env.SECRET_KEY as string },
        timeout: 5000,
      },
    );

    const user = toPublicUser(response?.data?.data) ?? null;

    if (user?.id && redisReady()) {
      try {
        await redis.set(key, JSON.stringify(user), { EX: USER_CACHE_SECONDS });
      } catch {
        // Non-fatal.
      }
    }

    return user;
  } catch (err: any) {
    console.error(
      `[users] lookup failed for ${userId}:`,
      err?.response?.data?.message ?? err?.message ?? err,
    );
    return null;
  }
}
