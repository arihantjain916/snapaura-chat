import { NextFunction, Request, Response } from "express";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { Socket, DefaultEventsMap, Server } from "socket.io";

const prisma = new PrismaClient();

interface AuthenticatedRequest extends Request {
  user: { id: string; [key: string]: any };
}

export const fetchUserDetail = async (data: string, client: any) => {
  try {
    const key = `user-${data}`;
    const cached = await client.get(key);

    if (cached) {
      return JSON.parse(cached);
    }

    const response = await axios.get(`${process.env.API_URL}/user/profile`, {
      headers: {
        Authorization: `Bearer ${data}`,
      },
    });

    await client.set(key, JSON.stringify(response?.data?.user), { EX: 40 });

    return response.data.user;
  } catch (err) {
    return err;
  }
};

export const saveMessage = async (
  socket: Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  users: Map<any, any>
) => {
  try {
    socket.on("send-msg", async (data) => {
      if (!data.senderId || !data.receiverId) return;

      var isChatExist: {
        id: string;
        created_at: Date;
        receiver_id: string;
        sender_id: string;
      } | null;
      isChatExist = await prisma.conversation.findFirst({
        where: {
          OR: [
            {
              sender_id: data.senderId,
              receiver_id: data.receiverId,
            },
            {
              sender_id: data.receiverId,
              receiver_id: data.senderId,
            },
          ],
        },
      });

      if (!isChatExist) {
        isChatExist = await prisma.conversation.create({
          data: {
            sender_id: data.senderId,
            receiver_id: data.receiverId,
          },
        });
      }

      const sendMessage = await prisma.message.create({
        data: {
          message: data.message,
          conversationId: isChatExist?.id,
          sender_id: data.senderId,
          receiver_id: data.receiverId,
          isReply: data.isReply || false,
          replyId: data.replyId || null,
        },
      });

      if (data?.file && data?.file?.length > 0) {
        await Promise.all(
          data.file.map(async (file: string, index: number) => {
            await prisma.message_attachment.create({
              data: {
                messageId: sendMessage.id,
                fileUrl: file,
                fileType: data.fileType[index],
                fileName: data.fileName[index],
              },
            });
          })
        );
      }

      const sendUserSocket = users.get(data.receiverId);
      const receiverUserSocket = users.get(data.senderId);
      if (!sendMessage) {
        io.to(receiverUserSocket).emit("error", "Failed to send message");
      }
      if (sendUserSocket) {
        io.to(sendUserSocket).emit("msg-recieve", sendMessage);
      }
    });
  } catch (e: any) {
    console.log(e);
    return {
      error: e.message,
      status: false,
    };
  }
};

export const fetchConversation = async (
  req: Request | AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const senderId = (req as AuthenticatedRequest).user.id;
  const senderDetails = (req as AuthenticatedRequest).user;
  const conversation = await prisma.conversation.findMany({
    where: {
      OR: [
        {
          sender_id: senderId,
        },
        {
          receiver_id: senderId,
        },
      ],
    },
  });

  if (conversation.length === 0) {
    res.status(200).json({
      status: false,
      data: [],
    });
    return;
  }

  const userIdsToFetch = Array.from(
    new Set(
      conversation.map((item) =>
        item.sender_id === senderId ? item.receiver_id : item.sender_id
      )
    )
  );

  let userDetails;

  try {
    userDetails = await Promise.all(
      userIdsToFetch.map(async (userId) => {
        try {
          return await fetchUserDetailfromBackend(userId, res);
        } catch (err: any) {
          throw new Error(
            `Error fetching details for userId ${userId}: ${err.message}`
          );
        }
      })
    );
  } catch (err: any) {
    res.status(500).json({
      status: false,
      error: err.message,
    });
    return;
  }

  const userDetailsMap = new Map(
    userDetails!.map((user) => [user.data.id, user.data])
  );

  const data = conversation.map((item) => ({
    id: item.id,
    senderId: item.sender_id,
    receiverId: item.receiver_id,
    createdAt: item.created_at,
    otherParty:
      item.sender_id === senderId
        ? userDetailsMap.get(item.receiver_id)
        : userDetailsMap.get(item.sender_id),
    senderName:
      item.sender_id === senderId
        ? senderDetails
        : userDetailsMap.get(item.sender_id),
  }));

  res.status(200).json({
    status: true,
    authUserId: senderId,
    data,
  });
  return;
};
export const fetchMessage = async (
  req: Request,
  res: Response
): Promise<void> => {
  const convoId = req.params.convoId;

  try {
    const messages = await prisma.message.findMany({
      where: { conversationId: convoId as string },
      include: {
        file_attachment: true,
      },
    });

    if (!messages || messages.length === 0) {
      res.status(200).json({
        message: "No messages found",
        data: [],
        success: true,
      });

      return;
    }

    const messageFilter = messages.map((message) => ({
      id: message.id,
      message: message.message,
      createdAt: message?.created_at,
      receiverId: message.receiver_id,
      senderId: message.sender_id,
      isReply: message.isReply,
      replyId: message.replyId,
      // type: message.conversationId ? "conversation" : "group",
      attachments: message?.file_attachment?.map((attachment) => ({
        fileUrl: attachment.fileUrl,
        fileType: attachment.fileType,
        fileName: attachment.fileName,
      })),
    }));

    res.status(200).json({
      message: "Messages found",
      data: messageFilter,
      success: true,
    });

    return;
  } catch (error: any) {
    res.status(500).json({
      message: "An error occurred while fetching messages",
      error: error.message,
      success: false,
    });
    return;
  }
};

async function fetchUserDetailfromBackend(data: string, res: any) {
  try {
    const res = await axios.get(`${process.env.API_URL}/user/info/${data}`, {
      headers: {
        "SECRET-KEY": process.env.SECRET_KEY as string,
      },
    });
    return res.data;
  } catch (error: any) {
    throw new Error(
      error.response?.data?.message || "Failed to fetch user details"
    );
  }
}

export const startConversation = async (
  req: Request | AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { receiver_id } = req.params;
    const { id } = (req as AuthenticatedRequest).user;

    const isChatExist = await prisma.conversation.findFirst({
      where: {
        OR: [
          {
            sender_id: id,
            receiver_id: receiver_id as string,
          },
          {
            sender_id: receiver_id as string,
            receiver_id: id,
          },
        ],
      },
    });

    if (!isChatExist) {
      await prisma.conversation.create({
        data: {
          sender_id: id,
          receiver_id: receiver_id as string,
        },
      });
    }

    res.status(200).json({
      message: "Conversation started successfully",
      success: true,
    });
    return;
  } catch (error: any) {
    res.status(500).json({
      message: "An error occurred while start conversation",
      error: error.message,
      success: false,
    });
    return;
  }
};
