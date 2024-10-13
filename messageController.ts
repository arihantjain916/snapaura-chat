import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { Socket, DefaultEventsMap, Server } from "socket.io";
import { stat } from "fs";
const prisma = new PrismaClient();

export const fetchUserDetail = async (data: string) => {
  try {
    const response = await axios.get(`${process.env.API_URL}/user/profile`, {
      headers: {
        Authorization: `Bearer ${data}`,
      },
    });

    return response.data.user;
  } catch (err) {
    console.log(err);
  }
};

export const saveMessage = async (
  socket: Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>,
  users: Map<any, any>
) => {
  socket.on("send-msg", async (data) => {
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
      },
    });

    if (!sendMessage) {
      console.log("error");
    }
    const sendUserSocket = users.get(data.receiverId);
    if (sendUserSocket) {
      io.to(sendUserSocket).emit("msg-recieve", data.message);
    }
  });
};

export const fetchConversation = async (req: any, res: any) => {
  const senderId = req.params.senderId;
  const conversation = await prisma.conversation.findFirst({
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

  if (!conversation) {
    return res.status(500).json({
      status: false,
      data: [],
    });
  }

  return res.status(200).json({
    status: true,
    data: conversation,
  });
};
export const fetchMessage = async (req: any, res: any) => {
  const senderId = req.params.senderId;
  const receiverId = req.params.receiverId;

  try {
    const conversation = await prisma.conversation.findFirst({
      where: {
        OR: [
          {
            sender_id: senderId,
            receiver_id: receiverId,
          },
          {
            sender_id: receiverId,
            receiver_id: senderId,
          },
        ],
      },
      select: { id: true },
    });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
        data: [],
      });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
    });

    if (!messages || messages.length === 0) {
      return res.status(404).json({
        message: "No messages found",
        data: [],
      });
    }

    const messageFilter = messages.map((message) => ({
      id: message.id,
      message: message.message,
      createdAt: message?.created_at,
      receiverId: message.receiver_id,
      senderId: message.sender_id,
      // type: message.conversationId ? "conversation" : "group",
      // attachments: message.fileAttachment.map((attachment) => ({
      //   fileUrl: attachment.fileUrl,
      //   fileType: attachment.fileType,
      // })),
    }));

    return res.status(200).json({
      message: "Messages found",
      data: messageFilter,
    });
  } catch (error: any) {
    return res.status(500).json({
      message: "An error occurred while fetching messages",
      error: error.message,
    });
  }
};
