import { Prisma, PrismaClient } from "@prisma/client";
import { Request, Response } from "express";
import { DefaultEventsMap, Server, Socket } from "socket.io";
import { sendError, sendSuccess } from "./apiResponse";
import { AuthenticatedRequest } from "./middleware/authMiddleware";
import { consumeSocketQuota } from "./rateLimit";
import { AuthUser, fetchUserById } from "./userService";

export const prisma = new PrismaClient();

const MAX_MESSAGE_LENGTH = 4000;
const MAX_ATTACHMENTS = 10;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

type ConversationRecord = Prisma.ConversationGetPayload<{}>;

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
 * Register the send-msg handler for an already-authenticated socket.
 *
 * The sender is taken from the socket's verified identity. It used to be read
 * straight out of the payload, so any anonymous client could emit a message
 * as any user, to any user.
 */
export const saveMessage = (
  socket: Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  users: Map<string, string>,
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

      if (attachments.length > 0) {
        const fileTypes = Array.isArray(data?.fileType) ? data.fileType : [];
        const fileNames = Array.isArray(data?.fileName) ? data.fileName : [];

        await prisma.message_attachment.createMany({
          // Parallel arrays were indexed blindly; a short fileType or fileName
          // array threw inside a Promise.all and took the process with it.
          data: attachments.slice(0, MAX_ATTACHMENTS).map((fileUrl: string, index: number) => ({
            messageId: sendMessage.id,
            fileUrl: String(fileUrl),
            fileType: String(fileTypes[index] ?? "raw"),
            fileName: String(fileNames[index] ?? "attachment"),
          })),
        });
      }

      const recipientSocket = users.get(receiverId);

      if (recipientSocket) {
        io.to(recipientSocket).emit("msg-recieve", sendMessage);
      }

      // Acknowledge to the sender so the client can reconcile its optimistic
      // copy; previously only failures were reported back, and to the wrong
      // socket at that.
      socket.emit("msg-sent", sendMessage);
    } catch (err: any) {
      console.error("[socket] send-msg failed:", err?.message ?? err);
      socket.emit("error", "Failed to send message");
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

    // allSettled, not all: one deleted or unreachable user used to fail the
    // caller's entire conversation list with a 500.
    const results = await Promise.allSettled(otherIds.map(fetchUserById));

    const userDetailsMap = new Map<string, AuthUser>();

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value?.id) {
        userDetailsMap.set(otherIds[index]!, result.value);
      }
    });

    const data = conversations.map((item) => {
      const otherId =
        item.sender_id === sender.id ? item.receiver_id : item.sender_id;

      return {
        id: item.id,
        senderId: item.sender_id,
        receiverId: item.receiver_id,
        createdAt: item.created_at,
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

    const data = messages.map((message) => ({
      id: message.id,
      message: message.message,
      createdAt: message.created_at,
      receiverId: message.receiver_id,
      senderId: message.sender_id,
      isReply: message.isReply,
      replyId: message.replyId,
      attachments: message.file_attachment.map((attachment) => ({
        fileUrl: attachment.fileUrl,
        fileType: attachment.fileType,
        fileName: attachment.fileName,
      })),
    }));

    sendSuccess(res, data, data.length > 0 ? "Messages found" : "No messages found");
  } catch (error: any) {
    console.error("[messages] fetch failed:", error?.message ?? error);
    sendError(res, "An error occurred while fetching messages", 500);
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
