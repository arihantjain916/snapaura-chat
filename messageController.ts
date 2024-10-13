import axios from "axios";
import { PrismaClient } from "@prisma/client";
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

export const saveMessage = async (socket, io, users) => {
  socket.on("send-msg", async (data) => {
    const isChatExist = await prisma.conversation.findFirst({
      where: {
        OR: [
          {
            senderId: data.senderId,
            receiverId: data.receiverId,
          },
          {
            senderId: data.receiverId,
            receiverId: data.senderId,
          },
        ],
      },
    });

    if (!isChatExist) {
      await prisma.conversation.create({
        data: {
          senderId: data.senderId,
          receiverId: data.receiverId,
        },
      });
    }

    await prisma.message.create({
      data: {
        senderId: data.senderId,
        receiverId: data.receiverId,
      },
    });
    // const sendUserSocket = users.get("9d347d85-672a-488e-8d89-84b9d8d0e043");
    //   console.log(sendUserSocket);
    //   if (sendUserSocket) {
    //     io.to(sendUserSocket).emit("msg-recieve", data.message);
    //   }
  });
};
