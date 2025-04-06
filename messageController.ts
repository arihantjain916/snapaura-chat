import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { Socket, DefaultEventsMap, Server } from "socket.io";
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
    throw err;
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
      throw "Error occured in line:66";
    }
    const sendUserSocket = users.get(data.receiverId);
    if (sendUserSocket) {
      console.log(sendMessage);
      io.to(sendUserSocket).emit("msg-recieve", sendMessage);
    }
  });
};

export const fetchConversation = async (req: any, res: any) => {
  const senderId = req.user.id;
  const senderDetails = req.user;
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
    return res.status(500).json({
      status: false,
      data: [],
    });
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
    return res.status(500).json({
      status: false,
      error: err.message,
    });
  }

  const userDetailsMap = new Map(
    userDetails.map((user) => [user.data.id, user.data])
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

  return res.status(200).json({
    status: true,
    authUserId: senderId,
    data,
  });
};
export const fetchMessage = async (req: any, res: any) => {
  const convoId = req.params.convoId;

  try {
    const messages = await prisma.message.findMany({
      where: { conversationId: convoId },
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
      success: true,
    });
  } catch (error: any) {
    return res.status(500).json({
      message: "An error occurred while fetching messages",
      error: error.message,
      success: false,
    });
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

export const startConversation = async (req: any, res: any) => {
  try {
    const { receiver_id } = req.params;
    const { id } = req.user;

    const isChatExist = await prisma.conversation.findFirst({
      where: {
        OR: [
          {
            sender_id: id,
            receiver_id: receiver_id,
          },
          {
            sender_id: receiver_id,
            receiver_id: id,
          },
        ],
      },
    });

    if (!isChatExist) {
      await prisma.conversation.create({
        data: {
          sender_id: id,
          receiver_id: receiver_id,
        },
      });
    }

    return res.status(200).json({
      message: "Conversation started successfully",
      success: true,
     
    });
  } catch (error: any) {
    return res.status(500).json({
      message: "An error occurred while start conversation",
      error: error.message,
      success: false,
    });
  }
};
