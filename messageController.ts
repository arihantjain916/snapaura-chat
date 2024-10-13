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

    return response.data.user.id;
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
