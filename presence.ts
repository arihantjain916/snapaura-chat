import { redis, redisReady } from "./redisClient";

/**
 * Who is currently connected.
 *
 * This replaces the `Map<userId, socketId>` that used to live in index.ts and
 * be threaded by hand into the socket handlers. Two problems with that shape:
 *
 *  - one socket per user, so a second tab (or a reconnect that races the old
 *    socket's disconnect) overwrote the entry and the first tab stopped
 *    receiving anything;
 *  - delivery went through the stored socket id, so a stale entry meant
 *    messages were emitted into the void.
 *
 * Presence is now a set of live socket ids per user, and delivery goes to a
 * per-user room instead of a socket id, so socket.io handles the fan-out.
 *
 * The registry is per-process. Running more than one instance needs the
 * socket.io Redis adapter as well; `lastSeen` is already in Redis so the
 * offline half of the answer is shared.
 */

const LAST_SEEN_KEY_PREFIX = "presence:last-seen:";
const LAST_SEEN_TTL_SECONDS = 60 * 60 * 24 * 30;

/** userId -> socket ids that user currently has open */
const sockets = new Map<string, Set<string>>();

export interface Presence {
  userId: string;
  isOnline: boolean;
  /** ISO timestamp, or null when we have never seen this user go offline. */
  lastSeen: string | null;
}

/** Every socket a user owns joins this room, so emits never name a socket id. */
export function roomFor(userId: string): string {
  return `user:${userId}`;
}

/** @returns true when this is the user's first live socket (offline -> online). */
export function addSocket(userId: string, socketId: string): boolean {
  let owned = sockets.get(userId);

  if (!owned) {
    owned = new Set();
    sockets.set(userId, owned);
  }

  const wasOffline = owned.size === 0;
  owned.add(socketId);

  return wasOffline;
}

/** @returns true when that was the user's last live socket (online -> offline). */
export function removeSocket(userId: string, socketId: string): boolean {
  const owned = sockets.get(userId);

  if (!owned) {
    return false;
  }

  owned.delete(socketId);

  if (owned.size > 0) {
    return false;
  }

  sockets.delete(userId);
  return true;
}

export function isOnline(userId: string): boolean {
  return (sockets.get(userId)?.size ?? 0) > 0;
}

function lastSeenKey(userId: string): string {
  return `${LAST_SEEN_KEY_PREFIX}${userId}`;
}

/**
 * Stamp the moment a user's last socket went away.
 *
 * Best-effort: without Redis the user simply reads back as "offline, last seen
 * unknown" rather than the request failing.
 */
export async function recordLastSeen(
  userId: string,
  at: Date = new Date(),
): Promise<string> {
  const iso = at.toISOString();

  if (redisReady()) {
    try {
      await redis.set(lastSeenKey(userId), iso, { EX: LAST_SEEN_TTL_SECONDS });
    } catch (err: any) {
      console.error("[presence] last-seen write failed:", err?.message ?? err);
    }
  }

  return iso;
}

async function lastSeenFor(userIds: string[]): Promise<Map<string, string>> {
  const seen = new Map<string, string>();

  // mGet rejects an empty key list.
  if (userIds.length === 0 || !redisReady()) {
    return seen;
  }

  try {
    const values = await redis.mGet(userIds.map(lastSeenKey));

    values.forEach((value, index) => {
      if (value) {
        seen.set(userIds[index]!, value);
      }
    });
  } catch (err: any) {
    console.error("[presence] last-seen read failed:", err?.message ?? err);
  }

  return seen;
}

/**
 * Online flag plus last-seen for a set of users, in one Redis round trip.
 */
export async function presenceFor(userIds: string[]): Promise<Presence[]> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const online = unique.filter(isOnline);
  const offline = unique.filter((id) => !isOnline(id));

  // Only the offline ones need a last-seen lookup; the rest are here now.
  const seen = await lastSeenFor(offline);

  return [
    ...online.map((userId) => ({ userId, isOnline: true, lastSeen: null })),
    ...offline.map((userId) => ({
      userId,
      isOnline: false,
      lastSeen: seen.get(userId) ?? null,
    })),
  ];
}
