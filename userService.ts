import axios from "axios";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import { redis, redisReady } from "./redisClient";

export interface AuthUser {
  id: string;
  username?: string;
  name?: string;
  profile?: string;
  [key: string]: any;
}

const PROFILE_CACHE_SECONDS = 40;

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

  const user = response?.data?.user as AuthUser | undefined;

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

    const user = (response?.data?.data as AuthUser) ?? null;

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
