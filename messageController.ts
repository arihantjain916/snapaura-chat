import { Prisma, PrismaClient } from "@prisma/client";
import { Request, Response } from "express";
import { DefaultEventsMap, Server, Socket } from "socket.io";
import { sendError, sendSuccess } from "./apiResponse";
import { AuthenticatedRequest } from "./middleware/authMiddleware";
import { presenceFor, roomFor } from "./presence";
import { consumeSocketQuota } from "./rateLimit";
import { AuthUser, fetchUserById } from "./userService";

export const prisma = new PrismaClient();

const MAX_MESSAGE_LENGTH = 4000;
const MAX_ATTACHMENTS = 10;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * A presence change is only announced to people the user actually talks to,
 * rather than broadcast to every connected socket. Capped so a user with a very
 * long conversation list cannot turn one connect into an unbounded fan-out.
 */
const MAX_PRESENCE_PEERS = 500;

type ConversationRecord = Prisma.ConversationGetPayload<{}>;
type MessageRecord = Prisma.MessageGetPayload<{
  include: { file_attachment: true };
}>;

/**
 * Mongo throws on a malformed id rather than returning nothing, which turned a
 * typo'd path segment into a 500.
 */
function isObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

/**
 * The one shape a message is published in.
 *
 * HTTP already answered in camelCase while the socket emitted the raw Prisma
 * row, so a client had to understand both `created_at` and `createdAt` for the
 * same message depending on how it arrived.
 */
function serializeMessage(
  message: MessageRecord | Prisma.MessageGetPayload<{}>,
  conversationId?: string,
) {
  const attachments =
    "file_attachment" in message && Array.isArray(message.file_attachment)
      ? message.file_attachment
      : [];

  return {
    id: message.id,
    conversationId: message.conversationId ?? conversationId ?? null,
    message: message.message,
    createdAt: message.created_at,
    receiverId: message.receiver_id,
    senderId: message.sender_id,
    isReply: message.isReply,
    replyId: message.replyId,
    isRead: message.is_read,
    readAt: message.read_at,
    attachments: attachments.map((attachment) => ({
      fileUrl: attachment.fileUrl,
      fileType: attachment.fileType,
      fileName: attachment.fileName,
    })),
  };
}

function otherParticipant(
  conversation: ConversationRecord,
  userId: string,
): string {
  return conversation.sender_id === userId
    ? conversation.receiver_id
    : conversation.sender_id;
}

/**
 * Order-independent identifier for a pair of users.
 *
 * Conversations were looked up with an OR over both orderings and created if
 * absent, with nothing stopping two concurrent sends from creating two rows
 * for the same pair and silently splitting the history.
 */
export function pairKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

async function findConversation(
  a: string,
  b: string,
): Promise<ConversationRecord | null> {
  return prisma.conversation.findFirst({
    where: {
      OR: [
        { pair_key: pairKeyFor(a, b) },
        // Rows written before pair_key existed.
        { sender_id: a, receiver_id: b },
        { sender_id: b, receiver_id: a },
      ],
    },
  });
}

async function findOrCreateConversation(
  senderId: string,
  receiverId: string,
): Promise<ConversationRecord> {
  const existing = await findConversation(senderId, receiverId);

  if (existing) {
    return existing;
  }

  try {
    return await prisma.conversation.create({
      data: {
        sender_id: senderId,
        receiver_id: receiverId,
        pair_key: pairKeyFor(senderId, receiverId),
      },
    });
  } catch (err) {
    // Lost a race with a concurrent create.
    const raced = await findConversation(senderId, receiverId);
    if (raced) {
      return raced;
    }
    throw err;
  }
}

function isParticipant(
  conversation: ConversationRecord,
  userId: string,
): boolean {
  return (
    conversation.sender_id === userId || conversation.receiver_id === userId
  );
}

type ChatServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  any
>;

/**
 * The socket server, so a read receipt raised over HTTP still reaches the other
 * party in real time. index.ts owns the instance and hands it over once.
 */
let socketServer: ChatServer | null = null;

export function setSocketServer(io: ChatServer): void {
  socketServer = io;
}

type MarkReadResult =
  | { ok: true; conversation: ConversationRecord; readAt: Date; count: number }
  | { ok: false; reason: "invalid" | "not-found" | "forbidden" };

/**
 * Flip every message in a conversation that was addressed to `userId` to read.
 *
 * Only the recipient's own rows are touched, so "mark this conversation read"
 * can never be used to mark the other side's messages read on their behalf.
 * Already-read rows are excluded from the filter, which keeps a client that
 * re-opens a conversation from rewriting `read_at` on every visit and from
 * emitting a receipt when nothing actually changed.
 */
export async function markConversationRead(
  conversationId: string,
  userId: string,
): Promise<MarkReadResult> {
  if (!isObjectId(conversationId)) {
    return { ok: false, reason: "invalid" };
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation) {
    return { ok: false, reason: "not-found" };
  }

  if (!isParticipant(conversation, userId)) {
    return { ok: false, reason: "forbidden" };
  }

  const readAt = new Date();

  const { count } = await prisma.message.updateMany({
    where: {
      conversationId,
      receiver_id: userId,
      is_read: false,
    },
    data: { is_read: true, read_at: readAt },
  });

  return { ok: true, conversation, readAt, count };
}

/**
 * Unread counts for a batch of conversations, as one aggregation rather than a
 * count query per row.
 */
async function unreadCounts(
  conversationIds: string[],
  userId: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  if (conversationIds.length === 0) {
    return counts;
  }

  const grouped = await prisma.message.groupBy({
    by: ["conversationId"],
    where: {
      conversationId: { in: conversationIds },
      receiver_id: userId,
      is_read: false,
    },
    _count: { _all: true },
  });

  grouped.forEach((row) => {
    if (row.conversationId) {
      counts.set(row.conversationId, row._count._all);
    }
  });

  return counts;
}

/** Mongo extended JSON, for the raw aggregations below. */
function oid(id: string) {
  return { $oid: id };
}

/**
 * When the caller last read each conversation — the newest `read_at` across the
 * messages addressed to them.
 *
 * Null for a conversation they have never opened, and for one whose history
 * predates read receipts (the backfill sets `is_read` without inventing a
 * `read_at` it cannot know).
 */
async function lastReadAtFor(
  conversationIds: string[],
  userId: string,
): Promise<Map<string, Date>> {
  const lastReads = new Map<string, Date>();

  if (conversationIds.length === 0) {
    return lastReads;
  }

  const grouped = await prisma.message.groupBy({
    by: ["conversationId"],
    where: {
      conversationId: { in: conversationIds },
      receiver_id: userId,
      is_read: true,
    },
    _max: { read_at: true },
  });

  grouped.forEach((row) => {
    if (row.conversationId && row._max.read_at) {
      lastReads.set(row.conversationId, row._max.read_at);
    }
  });

  return lastReads;
}

/**
 * The newest message in each conversation, in one round trip.
 *
 * Prisma cannot express "latest row per group", and the obvious workaround —
 * a findFirst per conversation — is a query per row of the list. This is the
 * aggregation instead: sorted ascending and taking `$last` rather than sorted
 * descending and taking `$first`, because ascending is exactly the
 * `(conversationId, created_at)` index and so sorts in the index rather than
 * in memory.
 */
async function lastMessagesFor(
  conversationIds: string[],
): Promise<Map<string, { id: string; message: string }>> {
  const latest = new Map<string, { id: string; message: string }>();

  if (conversationIds.length === 0) {
    return latest;
  }

  const rows = (await prisma.message.aggregateRaw({
    pipeline: [
      { $match: { conversationId: { $in: conversationIds.map(oid) } } },
      { $sort: { conversationId: 1, created_at: 1 } },
      {
        $group: {
          _id: "$conversationId",
          id: { $last: "$_id" },
          message: { $last: "$message" },
        },
      },
    ],
  })) as unknown as any[];

  rows.forEach((row) => {
    // Raw results come back as extended JSON, so ids are { $oid: "..." }.
    const conversationId = row?._id?.$oid ?? row?._id;
    const messageId = row?.id?.$oid ?? row?.id;

    if (conversationId && messageId) {
      latest.set(String(conversationId), {
        id: String(messageId),
        message: typeof row.message === "string" ? row.message : "",
      });
    }
  });

  return latest;
}

/**
 * Unread messages that arrived *after* the caller last read each conversation.
 *
 * Usually identical to the plain unread count. It diverges when a message is
 * unread but older than the read marker — a send that raced the receipt, or
 * history that predates read receipts entirely — which is exactly the case
 * where a client wants the two apart: this is the number to put on the "N new
 * messages" divider, while `unreadCount` is the number for the badge.
 *
 * The per-conversation cutoff differs, so this is one `$or` over the page
 * rather than a query per conversation.
 */
async function unreadSinceLastRead(
  conversationIds: string[],
  userId: string,
  lastReads: Map<string, Date>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  if (conversationIds.length === 0) {
    return counts;
  }

  const clauses = conversationIds.map((conversationId) => {
    const lastReadAt = lastReads.get(conversationId);

    // Never read: everything unread in it qualifies.
    return lastReadAt
      ? {
          conversationId: oid(conversationId),
          created_at: { $gt: { $date: lastReadAt.toISOString() } },
        }
      : { conversationId: oid(conversationId) };
  });

  const rows = (await prisma.message.aggregateRaw({
    pipeline: [
      { $match: { receiver_id: userId, is_read: false, $or: clauses } },
      { $group: { _id: "$conversationId", count: { $sum: 1 } } },
    ],
  })) as unknown as any[];

  rows.forEach((row) => {
    const conversationId = row?._id?.$oid ?? row?._id;

    if (conversationId) {
      counts.set(String(conversationId), Number(row.count) || 0);
    }
  });

  return counts;
}

/**
 * Everyone `userId` has a conversation with — the audience for their presence.
 */
async function conversationPeers(userId: string): Promise<string[]> {
  const conversations = await prisma.conversation.findMany({
    where: { OR: [{ sender_id: userId }, { receiver_id: userId }] },
    select: { sender_id: true, receiver_id: true },
    take: MAX_PRESENCE_PEERS,
  });

  const peers = new Set<string>();

  conversations.forEach((conversation) => {
    peers.add(conversation.sender_id);
    peers.add(conversation.receiver_id);
  });

  peers.delete(userId);

  return Array.from(peers);
}

/**
 * Tell a user's counterparties that they came online or went away.
 *
 * Deliberately not an io-wide broadcast: presence is only shared with people
 * the user already has a conversation with.
 */
export async function broadcastPresence(
  io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  userId: string,
  status: "online" | "offline",
  lastSeen: string | null = null,
): Promise<void> {
  try {
    const peers = await conversationPeers(userId);

    peers.forEach((peerId) => {
      io.to(roomFor(peerId)).emit("presence", { userId, status, lastSeen });
    });
  } catch (err: any) {
    // Presence is soft state; failing to announce it must not take down a
    // connect or disconnect path.
    console.error("[presence] broadcast failed:", err?.message ?? err);
  }
}

/**
 * Express 5 types route params as `string | string[]`, since a repeated
 * pattern can bind more than one value.
 */
function routeParam(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return "";
}

function pageSize(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.trunc(parsed), MAX_PAGE_SIZE);
}

/**
 * Register the chat handlers for an already-authenticated socket.
 *
 * The sender is taken from the socket's verified identity. It used to be read
 * straight out of the payload, so any anonymous client could emit a message
 * as any user, to any user.
 */
export const registerChatHandlers = (
  socket: Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
): void => {
  socket.on("send-msg", async (data: any) => {
    // The old try/catch wrapped this registration rather than the handler, so
    // every throw in here became an unhandled rejection.
    try {
      const sender = socket.data.user as AuthUser | undefined;

      if (!sender?.id) {
        socket.emit("error", "Not authenticated");
        return;
      }

      const receiverId = typeof data?.receiverId === "string" ? data.receiverId : "";
      const message = typeof data?.message === "string" ? data.message : "";

      if (!receiverId || receiverId === sender.id) {
        socket.emit("error", "Invalid recipient");
        return;
      }

      if (!message.trim() && !Array.isArray(data?.file)) {
        socket.emit("error", "Message is empty");
        return;
      }

      if (message.length > MAX_MESSAGE_LENGTH) {
        socket.emit("error", "Message is too long");
        return;
      }

      if (!(await consumeSocketQuota(sender.id, 60, 60))) {
        socket.emit("error", "You are sending messages too quickly");
        return;
      }

      const conversation = await findOrCreateConversation(sender.id, receiverId);

      const sendMessage = await prisma.message.create({
        data: {
          message,
          conversationId: conversation.id,
          sender_id: sender.id,
          receiver_id: receiverId,
          isReply: Boolean(data?.isReply),
          replyId: typeof data?.replyId === "string" ? data.replyId : null,
        },
      });

      const attachments = Array.isArray(data?.file) ? data.file : [];
      const savedAttachments: {
        fileUrl: string;
        fileType: string;
        fileName: string;
      }[] = [];

      if (attachments.length > 0) {
        const fileTypes = Array.isArray(data?.fileType) ? data.fileType : [];
        const fileNames = Array.isArray(data?.fileName) ? data.fileName : [];

        // Parallel arrays were indexed blindly; a short fileType or fileName
        // array threw inside a Promise.all and took the process with it.
        attachments
          .slice(0, MAX_ATTACHMENTS)
          .forEach((fileUrl: string, index: number) => {
            savedAttachments.push({
              fileUrl: String(fileUrl),
              fileType: String(fileTypes[index] ?? "raw"),
              fileName: String(fileNames[index] ?? "attachment"),
            });
          });

        await prisma.message_attachment.createMany({
          data: savedAttachments.map((attachment) => ({
            messageId: sendMessage.id,
            ...attachment,
          })),
        });
      }

      // The attachments were saved after the row was created, so the record in
      // hand does not carry them; the emitted payload has to.
      const payload = {
        ...serializeMessage(sendMessage, conversation.id),
        attachments: savedAttachments,
      };

      // Every device the recipient has open, not one remembered socket id.
      io.to(roomFor(receiverId)).emit("msg-recieve", payload);

      // Acknowledge to the sender so the client can reconcile its optimistic
      // copy; previously only failures were reported back, and to the wrong
      // socket at that.
      socket.emit("msg-sent", payload);
    } catch (err: any) {
      console.error("[socket] send-msg failed:", err?.message ?? err);
      socket.emit("error", "Failed to send message");
    }
  });

  /**
   * The recipient has the conversation open: mark their side read and tell the
   * sender, so a delivered tick can become a read tick.
   */
  socket.on("mark-read", async (data: any) => {
    try {
      const reader = socket.data.user as AuthUser | undefined;

      if (!reader?.id) {
        socket.emit("error", "Not authenticated");
        return;
      }

      const conversationId =
        typeof data?.conversationId === "string" ? data.conversationId : "";

      if (!conversationId) {
        socket.emit("error", "Conversation id is required");
        return;
      }

      if (!(await consumeSocketQuota(reader.id, 120, 60, "mark-read"))) {
        socket.emit("error", "You are sending events too quickly");
        return;
      }

      const result = await markConversationRead(conversationId, reader.id);

      if (!result.ok) {
        socket.emit(
          "error",
          result.reason === "forbidden"
            ? "You are not part of this conversation"
            : "Conversation not found",
        );
        return;
      }

      const receipt = {
        conversationId,
        readerId: reader.id,
        readAt: result.readAt,
        count: result.count,
      };

      // Confirm to the reader's own devices regardless, so a second tab clears
      // its unread badge too.
      io.to(roomFor(reader.id)).emit("read-confirmed", receipt);

      // Nothing changed means the other side already knows.
      if (result.count > 0) {
        const author = otherParticipant(result.conversation, reader.id);
        io.to(roomFor(author)).emit("msg-read", receipt);
      }
    } catch (err: any) {
      console.error("[socket] mark-read failed:", err?.message ?? err);
      socket.emit("error", "Failed to mark conversation as read");
    }
  });

  /** Presence for an explicit set of users, e.g. a freshly rendered list. */
  socket.on("get-presence", async (data: any) => {
    try {
      const viewer = socket.data.user as AuthUser | undefined;

      if (!viewer?.id) {
        socket.emit("error", "Not authenticated");
        return;
      }

      const requested = Array.isArray(data?.userIds)
        ? data.userIds.filter((id: unknown) => typeof id === "string")
        : [];

      socket.emit(
        "presence-list",
        await presenceFor(requested.slice(0, MAX_PRESENCE_PEERS)),
      );
    } catch (err: any) {
      console.error("[socket] get-presence failed:", err?.message ?? err);
      socket.emit("error", "Failed to read presence");
    }
  });
};

export const fetchConversation = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const sender = (req as AuthenticatedRequest).user;
  const take = pageSize(req.query.limit);
  const skip = Math.max(Number(req.query.skip) || 0, 0);

  try {
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [{ sender_id: sender.id }, { receiver_id: sender.id }],
      },
      orderBy: { created_at: "desc" },
      take,
      skip,
    });

    if (conversations.length === 0) {
      // authUserId was a top-level sibling of the payload; it is context about
      // the caller rather than the payload itself, so it lives in meta.
      sendSuccess(res, [], null, { authUserId: sender.id });
      return;
    }

    const otherIds = Array.from(
      new Set(
        conversations.map((item) =>
          item.sender_id === sender.id ? item.receiver_id : item.sender_id,
        ),
      ),
    );

    const conversationIds = conversations.map((item) => item.id);

    // allSettled, not all: one deleted or unreachable user used to fail the
    // caller's entire conversation list with a 500.
    const [results, unread, lastReads, lastMessages, presence] =
      await Promise.all([
        Promise.allSettled(otherIds.map(fetchUserById)),
        unreadCounts(conversationIds, sender.id),
        lastReadAtFor(conversationIds, sender.id),
        lastMessagesFor(conversationIds),
        presenceFor(otherIds),
      ]);

    // Sequential rather than part of the batch above: the cutoff for each
    // conversation is that conversation's own last-read timestamp.
    const unreadSince = await unreadSinceLastRead(
      conversationIds,
      sender.id,
      lastReads,
    );

    const userDetailsMap = new Map<string, AuthUser>();

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value?.id) {
        userDetailsMap.set(otherIds[index]!, result.value);
      }
    });

    const presenceMap = new Map(presence.map((item) => [item.userId, item]));

    const data = conversations.map((item) => {
      const otherId = otherParticipant(item, sender.id);
      const otherPresence = presenceMap.get(otherId);

      return {
        id: item.id,
        senderId: item.sender_id,
        receiverId: item.receiver_id,
        createdAt: item.created_at,
        // Messages addressed to the caller that they have not opened yet.
        unreadCount: unread.get(item.id) ?? 0,
        // When the caller last read this conversation, and how much of the
        // unread pile arrived after that point.
        lastReadAt: lastReads.get(item.id) ?? null,
        unreadSinceLastRead: unreadSince.get(item.id) ?? 0,
        lastMessage: lastMessages.get(item.id) ?? null,
        isOnline: otherPresence?.isOnline ?? false,
        lastSeen: otherPresence?.lastSeen ?? null,
        otherParty: userDetailsMap.get(otherId) ?? null,
        senderName:
          item.sender_id === sender.id
            ? sender
            : (userDetailsMap.get(item.sender_id) ?? null),
      };
    });

    sendSuccess(res, data, null, { authUserId: sender.id });
  } catch (error: any) {
    console.error("[conversations] fetch failed:", error?.message ?? error);
    sendError(res, "An error occurred while fetching conversations", 500);
  }
};

export const fetchMessage = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const convoId = routeParam(req.params.convoId);
  const viewer = (req as AuthenticatedRequest).user;
  const take = pageSize(req.query.limit);
  const skip = Math.max(Number(req.query.skip) || 0, 0);

  if (!convoId) {
    sendError(res, "Conversation id is required", 400);
    return;
  }

  if (!isObjectId(convoId)) {
    sendError(res, "Conversation id is not valid", 400);
    return;
  }

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: convoId },
    });

    if (!conversation) {
      sendError(res, "Conversation not found", 404);
      return;
    }

    // Any authenticated user could previously read any conversation just by
    // knowing (or guessing) its id.
    if (!isParticipant(conversation, viewer.id)) {
      sendError(res, "You are not part of this conversation", 403);
      return;
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: convoId },
      include: { file_attachment: true },
      // There was no ordering at all, so message order was whatever the
      // database happened to return.
      orderBy: { created_at: "asc" },
      take,
      skip,
    });

    const data = messages.map((message) => serializeMessage(message));

    const [counterparty] = await presenceFor([
      otherParticipant(conversation, viewer.id),
    ]);

    sendSuccess(
      res,
      data,
      data.length > 0 ? "Messages found" : "No messages found",
      {
        // Reading the messages does not mark them read: the client says when
        // they were actually shown, via POST /messages/:convoId/read or the
        // "mark-read" socket event.
        isOnline: counterparty?.isOnline ?? false,
        lastSeen: counterparty?.lastSeen ?? null,
      },
    );
  } catch (error: any) {
    console.error("[messages] fetch failed:", error?.message ?? error);
    sendError(res, "An error occurred while fetching messages", 500);
  }
};

/**
 * HTTP twin of the "mark-read" socket event, for clients that render a
 * conversation from GET /messages/:convoId and have no socket open.
 */
export const markMessagesRead = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const convoId = routeParam(req.params.convoId);
  const reader = (req as AuthenticatedRequest).user;

  if (!convoId) {
    sendError(res, "Conversation id is required", 400);
    return;
  }

  try {
    const result = await markConversationRead(convoId, reader.id);

    if (!result.ok) {
      if (result.reason === "forbidden") {
        sendError(res, "You are not part of this conversation", 403);
        return;
      }
      sendError(
        res,
        result.reason === "invalid"
          ? "Conversation id is not valid"
          : "Conversation not found",
        result.reason === "invalid" ? 400 : 404,
      );
      return;
    }

    const receipt = {
      conversationId: convoId,
      readerId: reader.id,
      readAt: result.readAt,
      count: result.count,
    };

    if (socketServer && result.count > 0) {
      const author = otherParticipant(result.conversation, reader.id);
      socketServer.to(roomFor(author)).emit("msg-read", receipt);
      socketServer.to(roomFor(reader.id)).emit("read-confirmed", receipt);
    }

    sendSuccess(res, receipt, "Conversation marked as read");
  } catch (error: any) {
    console.error("[messages] mark read failed:", error?.message ?? error);
    sendError(res, "An error occurred while marking messages as read", 500);
  }
};

/**
 * Online state for an explicit set of users: `?userIds=a,b,c`.
 */
export const fetchPresence = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const raw = typeof req.query.userIds === "string" ? req.query.userIds : "";

  const userIds = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_PRESENCE_PEERS);

  if (userIds.length === 0) {
    sendError(res, "userIds is required", 400);
    return;
  }

  try {
    sendSuccess(res, await presenceFor(userIds), "Presence found");
  } catch (error: any) {
    console.error("[presence] fetch failed:", error?.message ?? error);
    sendError(res, "An error occurred while fetching presence", 500);
  }
};

export const startConversation = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const receiver_id = routeParam(req.params.receiver_id);
  const sender = (req as AuthenticatedRequest).user;

  if (!receiver_id) {
    sendError(res, "Receiver id is required", 400);
    return;
  }

  if (receiver_id === sender.id) {
    sendError(res, "You cannot start a conversation with yourself", 422);
    return;
  }

  try {
    // The receiver was never checked, so conversations could be opened against
    // ids that do not belong to anybody.
    const receiver = await fetchUserById(receiver_id);

    if (!receiver?.id) {
      sendError(res, "User not found", 404);
      return;
    }

    const conversation = await findOrCreateConversation(sender.id, receiver_id);

    sendSuccess(res, { id: conversation.id }, "Conversation started successfully");
  } catch (error: any) {
    console.error("[conversations] start failed:", error?.message ?? error);
    sendError(res, "An error occurred while starting the conversation", 500);
  }
};
